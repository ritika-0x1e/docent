// Phase 6 chat (E1, E3, E4, E5 for chat): one question → sources → one streamed LLM answer → saved
// on the thread. Sources are the text selected on the page (E3) or the best 4–8 sections across the
// thread's pages (E1). The answer streams from Gemini, walking the Flash model ladder as quotas run
// out (decision 1), then from local Ollama. Prompt logic is in lib/chat-prompt.js, ladder logic in
// lib/gemini-ladder.js. Loaded into the service worker with importScripts().
// Plan: docs/phased-implementation-plan/phase-6-chat.md.

const MODEL_LIST_KEY = "geminiFlashModels"; // { fetchedAt, models: [id…] } in chrome.storage.local
const PARKED_KEY = "geminiParked"; // { [model]: until ms }: quota used up, skip until then
const MODEL_LIST_TTL_MS = 24 * 3600 * 1000;
const MAX_SOURCES = 8; // blended retrieval gives 4–8 sections; with a typo fix, both searches together are capped here
const SNIPPET_CHARS = 320;

// The chat ladder from the API's model list, cached for a day. If the list can't be read, the two
// models the code already knows.
async function chatLadder(key) {
  const cached = (await chrome.storage.local.get(MODEL_LIST_KEY))[MODEL_LIST_KEY];
  if (cached?.models?.length && Date.now() - cached.fetchedAt < MODEL_LIST_TTL_MS) return cached.models;
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
    if (response.ok) {
      const models = rankFlashModels((await response.json()).models ?? []);
      if (models.length) {
        await chrome.storage.local.set({ [MODEL_LIST_KEY]: { fetchedAt: Date.now(), models } });
        return models;
      }
    }
  } catch {
    /* offline or blocked: use the known models */
  }
  return [GEMINI_CHAT_MODEL, GEMINI_LABEL_MODEL];
}

async function parkModel(model, window) {
  const parked = (await chrome.storage.local.get(PARKED_KEY))[PARKED_KEY] ?? {};
  parked[model] = parkedUntil(window);
  await chrome.storage.local.set({ [PARKED_KEY]: parked });
  console.log(`[Summarizer/E4] ${model}: ${window === "day" ? "daily" : "per-minute"} quota used up, skipped until ${new Date(parked[model]).toLocaleString()}`);
}

// Reads a streamed body line by line ("data: {...}" for Gemini SSE, one JSON per line for Ollama).
async function readLines(response, onLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop();
    for (const line of lines) if (line.trim()) onLine(line.trim());
    if (done) return;
  }
}

// Full Flash models think before answering ("medium" by default on gemini-3.8-flash), and thinking
// isn't shown, so the panel sat on "Writing…" for seconds (user, 2026-11-07). Chat answers from given
// sources, so "low" (3.8's lowest level) is enough. Flash-Lite already defaults to "minimal": unchanged.
function withThinking(model, body) {
  if (/-flash-lite$/.test(model)) return body;
  return { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingLevel: "low" } } };
}

async function streamGemini(model, body, key, onDelta, signal) {
  const send = (payload) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      signal,
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(payload),
    });
  let response = await send(withThinking(model, body));
  let json = null;
  if (response.status === 400) {
    // A model that doesn't take this thinking setting: once more as plain, rather than off the ladder.
    json = await response.json().catch(() => null);
    if (/thinking/i.test(json?.error?.message ?? "")) {
      console.warn(`[Summarizer/E4] ${model} rejected thinkingLevel "low", retrying without it`);
      response = await send(body);
      json = null;
    }
  }
  if (!response.ok) {
    json ??= await response.json().catch(() => null);
    throw Object.assign(new Error(`Gemini ${model} HTTP ${response.status}: ${json?.error?.message ?? "no details"}`), { status: response.status, body: json });
  }
  let text = "";
  await readLines(response, (line) => {
    if (!line.startsWith("data:")) return;
    const chunk = JSON.parse(line.slice(5));
    // Thinking models may stream their reasoning as parts marked thought: true; only the answer shows.
    const delta = (chunk.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
    if (delta) {
      text += delta;
      onDelta(delta);
    }
  });
  return text;
}

async function streamOllama(body, onDelta, signal) {
  const response = await fetchOllama(body, { signal });
  let text = "";
  await readLines(response, (line) => {
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
    const delta = chunk.message?.content ?? "";
    if (delta) {
      text += delta;
      onDelta(delta);
    }
  });
  return text;
}

/**
 * Streams one answer: Gemini models down the ladder, then Ollama (E5).
 * @returns {Promise<{text, provider: "gemini"|"ollama", model, fallback: string|null}>}
 *   fallback: why Ollama answered ("gemini-quota" | "gemini-overloaded" | "gemini-error" | "no-gemini-key")
 */
async function streamAnswer(request, onDelta, signal) {
  const { geminiKey, provider, ollamaModel } = await getLlmConfig();
  let started = false;
  const emit = (delta) => ((started = true), onDelta(delta));
  let fallback = null;
  let lastError = null;

  if (provider === "gemini" && geminiKey) {
    const parked = (await chrome.storage.local.get(PARKED_KEY))[PARKED_KEY] ?? {};
    const models = usableModels(await chatLadder(geminiKey), parked);
    if (!models.length) fallback = "gemini-quota";
    const body = buildGeminiChatBody(request);
    for (const model of models) {
      try {
        return { text: await streamGemini(model, body, geminiKey, emit, signal), provider: "gemini", model, fallback: null };
      } catch (err) {
        // Once text has shown, switching models would restart the answer mid-way: report it instead.
        if (signal?.aborted || started) throw err;
        lastError = err;
        console.warn("[Summarizer/E4]", err.message);
        if (err.status === 429) {
          await parkModel(model, quotaWindow(err.body));
          fallback = "gemini-quota";
          continue;
        }
        if (err.status === 503 || err.status === 500 || err.status === 404) {
          fallback = "gemini-overloaded";
          continue;
        }
        fallback = "gemini-error"; // bad key, network error…: another model won't help
        break;
      }
    }
  } else if (provider === "gemini") {
    fallback = "no-gemini-key";
  }

  if (!ollamaModel) {
    if (provider === "ollama") throw new Error("Ollama is selected but no model is set. Open ⚙ settings.");
    if (fallback === "no-gemini-key") throw new Error("No Gemini key or local model set. Open ⚙ settings.");
    if (fallback === "gemini-quota" && !lastError) throw new Error("Every Gemini model's free quota is used up for today, and no Ollama model is set.");
    throw lastError ?? new Error("Gemini failed and no Ollama model is set.");
  }
  const text = await streamOllama(buildOllamaChatBody(request, ollamaModel), emit, signal);
  return { text, provider: "ollama", model: ollamaModel, fallback: provider === "ollama" ? null : fallback };
}

// E3: the page's selected text, or "" (nothing selected, or the page can't be scripted).
async function pageSelection(tabId) {
  try {
    if ((await ensureInjected(tabId)).blocked) return "";
    const reply = await chrome.tabs.sendMessage(tabId, { type: "get-selection" });
    return reply?.text ?? "";
  } catch {
    return "";
  }
}

// The thread's word list for typo correction (lib/spelling.js), kept for the last set of pages.
let vocabCache = { key: null, vocab: null };
async function threadVocabulary(refs) {
  const key = refs.join("|");
  if (vocabCache.key !== key) {
    const corpora = await Promise.all(refs.map((id) => getCorpus(id)));
    vocabCache = { key, vocab: buildVocabulary(corpora.flatMap((c) => (c?.sections ?? []).map((s) => `${s.heading ?? ""} ${s.text}`))) };
  }
  return vocabCache.vocab;
}

// Top hits for the question, and for its typo-corrected form when there is one: each section keeps
// its better score.
async function retrieveHits(refs, question) {
  const { hits } = await retrieve(refs, question, "blended");
  const corrected = correctQuery(question, await threadVocabulary(refs));
  if (!corrected) return hits;
  console.log(`[Summarizer/E1] also searching with ${corrected.fixes.map((f) => `"${f.from}" → "${f.to}"`).join(", ")}`);
  const best = new Map(hits.map((h) => [`${h.corpusId}|${h.sectionId}`, h]));
  for (const h of (await retrieve(refs, corrected.text, "blended")).hits) {
    const key = `${h.corpusId}|${h.sectionId}`;
    if (h.score > (best.get(key)?.score ?? -Infinity)) best.set(key, h);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, MAX_SOURCES);
}

// E1: the top sections across every page in the thread, with what the source cards need.
async function retrieveSources(thread, question) {
  const pages = new Map(thread.pages.map((p) => [p.corpusRef, p]));
  const hits = await retrieveHits(corpusRefs(thread), question);
  return hits.map((h) => {
    const chunk = chunkSection(h.section)[h.bestChunkIndex]?.text ?? h.section.text;
    const page = pages.get(h.corpusId);
    return {
      corpusId: h.corpusId,
      sectionId: h.sectionId,
      order: h.section.order,
      pageUrl: page?.url ?? null,
      pageTitle: page?.title ?? null,
      heading: h.section.heading,
      headingPath: h.section.headingPath ?? [],
      text: h.section.text,
      blocks: h.section.blocks ?? [], // for passages (phase 7); not saved on the message
      highlightable: (h.section.blocks ?? []).some((b) => b.anchored),
      jump: Boolean(h.section.jump), // Google Docs: Jump to section instead of a highlight
      snippet: chunk.slice(chunk.lastIndexOf("\n") + 1).slice(0, SNIPPET_CHARS),
      score: h.score,
    };
  });
}

// Hallucination check (lib/grounding.js): each answer sentence against windows of the sources it was
// given, embedded locally, plus the numbers it states.
async function checkGrounding(answerText, sources, question) {
  const sentences = answerSentences(answerText);
  const toCheck = sentences.filter((s) => s.check);
  if (!toCheck.length) return judgeAnswer(sentences, [], new Set());
  const texts = sources.map((s) => stripFootnotes(s.text));
  const windows = sourceWindows(texts);
  const { vectors } = await embedTexts([...toCheck.map((s) => s.plain), ...windows]);
  const claimVecs = vectors.slice(0, toCheck.length);
  const windowVecs = vectors.slice(toCheck.length);
  const best = new Map(toCheck.map((s, i) => [s, Math.max(...windowVecs.map((w) => dot(claimVecs[i], w)))]));
  const all = `${texts.join("\n")}\n${question}`;
  return judgeAnswer(sentences, sentences.map((s) => best.get(s) ?? null), sourceNumbers(all), { words: sourceWordSet(all) });
}

// F2 (phase 7): the passages inside each cited section that support the claims citing it
// (lib/passages.js). Answers that cite nothing match every claim against all their sources.
// @returns {Map<number, {blockId, exact}[]>}  source number → passages (missing: show the section)
async function findPassages(answerText, sources, cited, uncited) {
  const result = new Map();
  let claims;
  if (uncited) {
    const all = answerSentences(answerText).filter((s) => s.check).map((s) => s.plain);
    claims = new Map(cited.map((n) => [n, all]));
  } else {
    claims = claimsByCitation(answerText);
  }
  const jobs = cited
    .filter((n) => sources[n - 1]?.highlightable && claims.get(n)?.length)
    .map((n) => ({ n, claims: claims.get(n), windows: blockWindows(sources[n - 1].blocks) }))
    .filter((job) => job.windows.length);
  if (!jobs.length) return result;
  // One embedding call for everything.
  const texts = jobs.flatMap((job) => [...job.claims, ...job.windows.map((w) => w.exact)]);
  const { vectors } = await embedTexts(texts);
  let at = 0;
  const perJob = jobs.map((job) => {
    const claimVecs = vectors.slice(at, (at += job.claims.length));
    const windowVecs = vectors.slice(at, (at += job.windows.length));
    return { job, claimVecs, windowVecs };
  });
  if (uncited) {
    // Each claim goes to the one source it matches best, not to all five.
    const owner = new Map(); // claim → {n, score}
    for (const { job, claimVecs, windowVecs } of perJob) {
      job.claims.forEach((claim, i) => {
        const score = Math.max(...windowVecs.map((w) => dot(claimVecs[i], w)));
        if (score > (owner.get(claim)?.score ?? -Infinity)) owner.set(claim, { n: job.n, score });
      });
    }
    for (const { job, claimVecs, windowVecs } of perJob) {
      const mine = claimVecs.filter((_, i) => owner.get(job.claims[i])?.n === job.n);
      const picked = pickPassages(mine, job.windows, windowVecs);
      if (picked.length) result.set(job.n, picked);
    }
  } else {
    for (const { job, claimVecs, windowVecs } of perJob) {
      const picked = pickPassages(claimVecs, job.windows, windowVecs);
      if (picked.length) result.set(job.n, picked);
    }
  }
  return result;
}

// The relevance gate (lib/grounding.js). A short follow-up ("and when was it rebuilt?") barely
// matches anything alone, so before giving up it's retried together with the previous question.
async function retrieveRelevant(thread, question) {
  let sources = await retrieveSources(thread, question);
  if (isRelevant(sources[0]?.score)) return { sources, relevant: true };
  const previous = [...(thread.messages ?? [])].reverse().find((m) => m.role === "user")?.content;
  if (previous) {
    const withContext = await retrieveSources(thread, `${previous} ${question}`);
    if (isRelevant(withContext[0]?.score)) return { sources: withContext, relevant: true };
    if ((withContext[0]?.score ?? -1) > (sources[0]?.score ?? -1)) sources = withContext;
  }
  return { sources, relevant: false };
}

/**
 * One chat turn on the tab's thread.
 * @param {boolean} force  "Ask anyway" after the relevance gate: skip the gate, and replace the gated
 *   turn for this question instead of adding a second one
 * @param {{onSources, onDelta, onChecking}} callbacks  onSources({mode, count}) once the sources are
 *   known; onDelta(text) per streamed piece of the answer; onChecking() when the grounding check starts
 * @returns {Promise<{ok: true, thread, message}>}  the thread as saved, with both new messages
 */
async function answerQuestion({ tabId, threadId, question, force = false }, { onSources = () => {}, onDelta = () => {}, onChecking = () => {}, signal } = {}) {
  const thread = threadId ? await getThread(threadId) : null;
  if (!thread) throw new Error("Scan this page first: chat runs inside a thread.");
  // A long local answer can outlast MV3's 30s idle timer; an extension API call every 20s resets it.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const tStart = Date.now();
  try {
    const selection = await pageSelection(tabId);
    const mode = selection ? "selection" : "retrieval";
    let sources;
    let relevant = true;
    if (selection) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      sources = [{ pageTitle: tab?.title ?? null, pageUrl: tab?.url ?? null, heading: "Your selection", text: selection, selection: true }];
    } else if (force) {
      sources = await retrieveSources(thread, question);
    } else {
      ({ sources, relevant } = await retrieveRelevant(thread, question));
    }
    const topScore = mode === "retrieval" ? (sources[0]?.score ?? null) : null;
    onSources({ mode, count: relevant ? sources.length : 0 });
    console.log(
      `[Summarizer/E1] ${mode === "selection" ? `answering from the selection (${selection.split(" ").length} words), no retrieval` : `${sources.length} sources retrieved, best ${topScore?.toFixed(3)}${relevant ? "" : `: below ${RELEVANCE_MIN}, not covered, the model isn't asked`}${force ? " (ask anyway)" : ""}`}`
    );

    const userMessage = { role: "user", content: question, createdAt: Date.now() };
    const tAsk = Date.now();
    const msSources = tAsk - tStart; // selection read or retrieval (embedding the question)
    let msFirstText = null;
    const firstText = (d) => (msFirstText ??= Date.now() - tAsk, d);
    let answer;
    let stopped = false;
    let partial = "";
    if (!sources.length || !relevant) {
      answer = { text: NOT_COVERED, provider: null, model: null, fallback: null };
      onDelta(NOT_COVERED);
    } else {
      try {
        answer = await streamAnswer({ question, history: thread.messages, sources, mode }, (d) => ((partial += d), onDelta(firstText(d))), signal);
      } catch (err) {
        if (!signal?.aborted || !partial) throw err;
        stopped = true; // Stop: keep what was written
        answer = { text: partial, provider: null, model: null, fallback: null };
      }
    }

    const msAnswer = Date.now() - tAsk;
    let content = answer.text;
    let notCovered = isNotCovered(content);
    // Hallucination check on what the model wrote. Not on a stopped answer (half a sentence can't be
    // judged) or a "not covered" reply. If the check itself fails, the answer stays, unchecked.
    let grounding = null;
    let rejected = null;
    let msCheck = null;
    if (answer.provider && !stopped && !notCovered && content.trim()) {
      onChecking();
      const tCheck = Date.now();
      try {
        grounding = await checkGrounding(content, sources, question);
        msCheck = Date.now() - tCheck;
      } catch (err) {
        console.warn("[Summarizer/E4] grounding check failed, answer kept unchecked:", err.message);
      }
      if (grounding?.verdict === "ungrounded") {
        // Nothing in it was found in the sources: shown as not covered, the model's text folded away.
        // History sends "not covered" on, so the next answer doesn't build on the made-up one.
        rejected = content;
        content = NOT_COVERED;
        notCovered = true;
      }
    }

    let cited = mode === "retrieval" && !notCovered ? citedNumbers(content, sources.length) : [];
    // An answer that cites nothing (small models sometimes skip it) still came from these sources:
    // show them all, marked as not cited. A "not covered" reply from the model shows them too, so it's
    // visible whether retrieval missed or the model was strict (user, 2026-11-07). Not when the gate
    // answered: those sections weren't close to the question at all.
    const uncited = mode === "retrieval" && relevant && !cited.length && !stopped && content.trim().length > 0;
    if (uncited) cited = sources.map((_, i) => i + 1);
    // Selection mode: the answer is about the selected text, so [1] is that text; clicking it
    // highlights the selection on its page again (user, 2026-11-07).
    if (mode === "selection" && !notCovered && !stopped && content.trim()) cited = [1];
    let passages = new Map();
    if (cited.length && !stopped && !notCovered) {
      try {
        passages = await findPassages(content, sources, cited, uncited);
      } catch (err) {
        console.warn("[Summarizer/F2] passage matching failed, citations show whole sections:", err.message);
      }
    }
    const assistantMessage = {
      role: "assistant",
      content,
      createdAt: Date.now(),
      mode,
      notCovered,
      gated: !relevant, // the relevance gate answered; the model wasn't asked
      topScore,
      rejected, // the model's answer when the grounding check found none of it in the sources
      grounding: grounding && { verdict: grounding.verdict, unsupported: grounding.sentences.filter((s) => s.supported === false).map((s) => ({ text: s.text, support: s.support, missing: s.missing })) },
      uncited,
      stopped,
      provider: answer.provider,
      model: answer.model,
      fallback: answer.fallback,
      // Spec schema {pageUrl, sectionId}, plus what the cards and phase 7's highlighting need.
      // passages (phase 7): the text inside the section that supports the claim, [{blockId, exact}].
      citedSections: cited.map((n) => {
        if (sources[n - 1].selection) {
          const { text, selection, ...source } = sources[n - 1];
          return { n, ...source, selection: true, quote: text, snippet: text.slice(0, SNIPPET_CHARS), highlightable: true, passages: [] };
        }
        const { text, blocks, ...source } = sources[n - 1];
        return { n, ...source, passages: (passages.get(n) ?? []).map(({ blockId, exact }) => ({ blockId, exact })) };
      }),
    };
    const saved = await updateThread(thread.id, (fresh) => {
      let messages = fresh.messages ?? [];
      // Ask anyway replaces the gated turn it came from.
      const [lastQ, lastA] = messages.slice(-2);
      if (force && lastA?.gated && lastQ?.role === "user" && lastQ.content === question) messages = messages.slice(0, -2);
      return { ...fresh, messages: [...messages, userMessage, assistantMessage] };
    });
    if (!saved) throw new Error("This thread was deleted while answering.");
    console.log(
      `[Summarizer/E4] answered via ${answer.provider ?? "none"}${answer.model ? ` (${answer.model})` : ""}${answer.fallback ? `, fallback: ${answer.fallback}` : ""}; cited ${cited.join(", ") || "nothing"}${grounding ? `; grounding: ${grounding.verdict}${grounding.verdict !== "grounded" ? ` (${assistantMessage.grounding.unsupported.length} sentence(s) not found in the sources)` : ""}` : ""}${stopped ? "; stopped" : ""}` +
        (answer.provider ? `; sources ${(msSources / 1000).toFixed(1)}s, first text after ${(msFirstText / 1000).toFixed(1)}s, answer ${(msAnswer / 1000).toFixed(1)}s${msCheck != null ? `, check ${(msCheck / 1000).toFixed(1)}s` : ""}` : "")
    );
    return { ok: true, thread: saved, message: assistantMessage };
  } finally {
    clearInterval(keepAlive);
  }
}
