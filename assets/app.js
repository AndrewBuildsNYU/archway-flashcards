/* Archway Flashcards: owns the prompt, the defensive JSON parse, the review queue
   and the Anki export. Everything about keys, models and HTTP lives in archway.js.

   This file is UTF-8 and index.html is pure ASCII with HTML entities for its
   punctuation. That is not fussiness: the published index.html had been saved
   through a Latin-1 round trip and was serving a double-encoded "A-circumflex"
   in its own title. Entities in the markup make that unrepeatable. */
(function () {
  "use strict";

  var SAMPLE_NOTES = [
    "Lecture 9 - Consistency models in replicated data stores",
    "",
    "Replication buys availability and read throughput, but it forces a decision about what a read is",
    "allowed to return when two replicas disagree.",
    "",
    "Linearizability (strong consistency): every operation appears to take effect at a single instant",
    "between its invocation and its response, and that order matches real time. Requires coordination -",
    "a consensus protocol such as Raft or Paxos - so every write pays at least one round trip to a quorum.",
    "",
    "Sequential consistency is weaker. All clients agree on one total order of operations, but that order",
    "need not respect real time, so a read may return a stale value as long as every client sees the same",
    "history.",
    "",
    "Causal consistency preserves happens-before. If write A happened before write B, no replica may expose",
    "B without A. Writes that are concurrent may appear in different orders at different replicas.",
    "Implemented with vector clocks or explicit dependency tracking; needs no consensus, so it stays",
    "available during a partition.",
    "",
    "Eventual consistency promises only convergence once writes stop. Dynamo-style systems lean on sloppy",
    "quorums, hinted handoff, and conflict resolution by last-write-wins or CRDTs.",
    "",
    "Session guarantees - read-your-writes, monotonic reads, monotonic writes - are client-centric",
    "properties layered on top of a weaker store, usually by pinning a session to one replica or carrying a",
    "version token with the client.",
    "",
    "Quorum arithmetic: with N replicas, R + W > N makes every read set overlap every write set. R=1, W=N",
    "favours readers; R=N, W=1 favours writers.",
    "",
    "PACELC extends CAP: if a partition (P) happens, trade availability (A) against consistency (C); else",
    "(E), in normal operation, trade latency (L) against consistency (C). Spanner picks C in both cases and",
    "pays for it with TrueTime commit waits. Cassandra is tunable per query."
  ].join("\n");

  var SYSTEM = "You write study flashcards from a student's own lecture notes. You return data, " +
    "not prose: a single JSON object and nothing else. No preamble, no markdown code fences, no trailing " +
    "commentary.";

  var STYLES = {
    recall: "Recall. Ask for definitions, named mechanisms and specific facts that the notes state outright.",
    understand: "Understand. Ask why something holds, how two ideas differ, or what a mechanism causes. " +
      "Prefer comparisons and consequences over vocabulary.",
    apply: "Apply. Pose a short concrete scenario (a system, a design choice, a failure) and ask the " +
      "student to choose or justify an approach using the ideas in the notes."
  };

  function $(id) { return document.getElementById(id); }

  var els = {
    notes: $("notes"), sample: $("sample"), count: $("count"), difficulty: $("difficulty"),
    model: $("model"), generate: $("generate"), stop: $("stop"), keyHint: $("key-hint"),
    genStatus: $("gen-status"), genSpinner: $("gen-spinner"), genProgress: $("gen-progress"),
    error: $("error"), readout: $("readout"),
    deckSection: $("deck-section"), deckCount: $("deck-count"), exportSection: $("export-section"),
    rawSection: $("raw-section"), rawOut: $("raw-out"),
    viewReview: $("view-review"), viewDeck: $("view-deck"),
    reviewPanel: $("review-panel"), deckPanel: $("deck-panel"), summaryPanel: $("summary-panel"),
    deckList: $("deck-list"),
    flash: $("flash"), faceFront: $("face-front"), faceBack: $("face-back"),
    frontText: $("front-text"), frontTag: $("front-tag"), backText: $("back-text"),
    revealRow: $("reveal-row"), reveal: $("reveal"), gradeRow: $("grade-row"),
    gradeAgain: $("grade-again"), gradeHard: $("grade-hard"), gradeGood: $("grade-good"),
    prev: $("prev"), next: $("next"),
    countAgain: $("count-again"), countHard: $("count-hard"), countGood: $("count-good"),
    progressLabel: $("progress-label"), progressMeter: $("progress-meter"), progressFill: $("progress-fill"),
    downloadCsv: $("download-csv"), copyTsv: $("copy-tsv"),
    exportStatus: $("export-status"), exportSpinner: $("export-spinner")
  };

  var state = {
    deck: [],          // [{id, front, back, tag}]
    queue: [],         // [{card, grade}] - an "Again" appends a second entry for the same card
    pos: 0,
    revealed: false,
    counts: { again: 0, hard: 0, good: 0 },
    view: "review",
    startedAt: 0,
    controller: null
  };

  var modelsById = {};

  /* Show or hide one of the .spinner rings. Every async path turns its own
     spinner off in a finally, so a rejected promise cannot leave one turning. */
  function spin(node, on) {
    if (node) node.classList.toggle("hidden", !on);
  }

  /* ---------- setup ---------- */

  Archway.mountThemeToggle($("theme-toggle"));

  Archway.mountKeyPanel($("key-mount"), {
    onReady: function () { loadModels(); },
    onClear: function () {
      setReady(false);
      els.model.disabled = true;
      Archway.clear(els.model);
      els.model.appendChild(Archway.el("option", "", "Connect a key first"));
    }
  });

  function setReady(on) {
    els.generate.disabled = !on;
    els.model.disabled = !on;
    els.keyHint.classList.toggle("hidden", on);
  }

  function loadModels() {
    els.genStatus.textContent = "Loading models\u2026";
    spin(els.genSpinner, true);
    Archway.listModels().then(function (models) {
      modelsById = {};
      models.forEach(function (m) { modelsById[m.id] = m; });
      Archway.clear(els.model);
      Archway.fillModelSelect(els.model, models, "claude");
      setReady(models.length > 0);
      els.genStatus.textContent = models.length ? "" : "This key has no chat models available.";
    }).catch(function (err) {
      setReady(false);
      els.genStatus.textContent = "";
      Archway.renderError(els.error, err);
    }).finally(function () {
      spin(els.genSpinner, false);
    });
  }

  /* ---------- generation ---------- */

  function userPrompt(notes, count, style) {
    return [
      "Make exactly " + count + " flashcards from the notes below.",
      "",
      "Rules:",
      '- "front" is a question a tutor would ask out loud. Never a fill-in-the-blank stub, never a bare',
      "  heading with a question mark bolted on.",
      '- "back" answers it completely on its own. It must make sense to someone who cannot see the notes,',
      "  the question, or any other card. Two or three sentences at most.",
      '- "tag" is a one-to-three word topic label, reused across related cards.',
      "- " + STYLES[style],
      "- Cover the whole of the notes, not just the opening paragraphs. No two cards may test the same fact.",
      "",
      "Respond with exactly this shape and nothing else:",
      '{"cards":[{"front":"...","back":"...","tag":"..."}]}',
      "",
      "NOTES:",
      notes
    ].join("\n");
  }

  // Models drift towards prose and fences even under a strict instruction, so take the
  // outermost braces rather than trusting the whole response to be JSON.
  function extractJson(text) {
    var s = String(text || "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    var start = s.indexOf("{");
    var end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      return null;
    }
  }

  function parseCards(text) {
    var data = extractJson(text);
    var raw = data && Array.isArray(data.cards) ? data.cards : [];
    var cards = [];
    raw.forEach(function (c) {
      if (!c || typeof c !== "object") return;
      var front = typeof c.front === "string" ? c.front.trim() : "";
      var back = typeof c.back === "string" ? c.back.trim() : "";
      if (!front || !back) return;
      cards.push({
        id: Archway.uuid(),
        front: front,
        back: back,
        tag: (typeof c.tag === "string" && c.tag.trim()) ? c.tag.trim() : "general"
      });
    });
    return cards;
  }

  function busy(on) {
    els.sample.disabled = on;
    els.count.disabled = on;
    els.difficulty.disabled = on;
    els.notes.readOnly = on;
    els.stop.classList.toggle("hidden", !on);
    spin(els.genSpinner, on);
    if (on) {
      els.generate.disabled = true;
      els.model.disabled = true;
    } else {
      setReady(Archway.hasKey());   // a key cleared mid-flight must not leave the button live
      els.genProgress.textContent = "";
    }
  }

  function generate() {
    var notes = els.notes.value.trim();
    Archway.clear(els.error);
    if (notes.length < 40) {
      Archway.renderError(els.error, new Error(
        "Paste at least a paragraph of notes \u2014 a sentence or two is not enough to build a deck from."));
      els.notes.focus();
      return;
    }

    var count = parseInt(els.count.value, 10);
    var model = els.model.value;
    var info = modelsById[model];
    // Asking for more output than the model allows is a 400 from the vendor, so clamp.
    var room = 220 * count + 600;
    var maxTokens = info && info.max_output_tokens ? Math.min(room, info.max_output_tokens) : room;

    state.controller = new AbortController();
    busy(true);
    els.genStatus.textContent = "Writing " + count + " cards\u2026";

    Archway.streamChat({
      model: model,
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt(notes, count, els.difficulty.value) }],
      maxTokens: maxTokens,
      temperature: 0.3,
      signal: state.controller.signal
    }, function (frag, full) {
      // Noisy for a screen reader, so this counter is aria-hidden; #gen-status announces.
      els.genProgress.textContent = Archway.formatInt(full.length) + " characters";
    }).then(function (res) {
      Archway.renderReadout(els.readout, res.headers, { ms: res.ms });
      var cards = parseCards(res.text);
      if (!cards.length) {
        els.rawOut.textContent = res.text;
        els.rawSection.classList.remove("hidden");
        els.genStatus.textContent = "No usable cards in that response.";
        return;
      }
      els.rawSection.classList.add("hidden");
      els.genStatus.textContent = "Built " + cards.length + " cards.";
      buildDeck(cards);
    }).catch(function (err) {
      if (err && err.name === "AbortError") {
        els.genStatus.textContent = "Stopped.";
        return;
      }
      els.genStatus.textContent = "";
      Archway.renderError(els.error, err);
    }).finally(function () {
      state.controller = null;
      busy(false);
    });
  }

  /* ---------- review queue ---------- */

  function buildDeck(cards) {
    state.deck = cards;
    els.deckCount.textContent = cards.length + (cards.length === 1 ? " card" : " cards");
    els.deckSection.classList.remove("hidden");
    els.exportSection.classList.remove("hidden");
    els.exportStatus.textContent = "";
    renderDeckList();
    restart();
    switchView("review");
  }

  function restart() {
    state.queue = state.deck.map(function (c) { return { card: c, grade: null }; });
    state.pos = 0;
    state.revealed = false;
    state.counts = { again: 0, hard: 0, good: 0 };
    state.startedAt = Date.now();
    els.summaryPanel.classList.add("hidden");
    els.reviewPanel.classList.remove("hidden");
    renderCard();
  }

  // A card counts as settled when its most recent grade was Hard or Good; an "Again"
  // un-settles it until the repeat comes round.
  function settledCount() {
    var last = {};
    state.queue.forEach(function (e) { if (e.grade) last[e.card.id] = e.grade; });
    var n = 0;
    Object.keys(last).forEach(function (id) { if (last[id] !== "again") n += 1; });
    return n;
  }

  function renderCard() {
    var entry = state.queue[state.pos];
    if (!entry) return;
    var card = entry.card;

    els.frontText.textContent = card.front;
    els.frontTag.textContent = card.tag;
    els.backText.textContent = card.back;

    els.flash.classList.toggle("is-flipped", state.revealed);
    els.faceFront.setAttribute("aria-hidden", state.revealed ? "true" : "false");
    els.faceBack.setAttribute("aria-hidden", state.revealed ? "false" : "true");
    els.revealRow.classList.toggle("hidden", state.revealed);
    els.gradeRow.classList.toggle("hidden", !state.revealed);

    els.prev.disabled = state.pos === 0;
    els.next.disabled = state.pos >= state.queue.length - 1;

    // The dot beside each word carries the colour; the number stays in ink.
    els.countAgain.textContent = String(state.counts.again);
    els.countHard.textContent = String(state.counts.hard);
    els.countGood.textContent = String(state.counts.good);

    var repeats = state.queue.length - state.deck.length;
    els.progressLabel.textContent = "Card " + (state.pos + 1) + " of " + state.queue.length +
      (repeats > 0 ? " (" + repeats + " to see again)" : "");

    var pct = state.deck.length ? Math.round((settledCount() / state.deck.length) * 100) : 0;
    els.progressFill.style.width = pct + "%";
    els.progressMeter.setAttribute("aria-valuenow", String(pct));
    els.progressMeter.setAttribute("aria-valuetext", pct + " percent of the deck settled");
  }

  function reveal() {
    if (state.revealed) return;
    state.revealed = true;
    renderCard();
    els.faceBack.focus();
  }

  function grade(kind) {
    if (!state.revealed) return;
    var entry = state.queue[state.pos];
    if (!entry) return;

    if (entry.grade) state.counts[entry.grade] -= 1;   // re-grading after an arrow-key backtrack
    state.counts[kind] += 1;
    var first = !entry.grade;
    entry.grade = kind;
    if (kind === "again" && first) state.queue.push({ card: entry.card, grade: null });

    state.pos += 1;
    state.revealed = false;
    if (state.pos >= state.queue.length) {
      showSummary();
    } else {
      renderCard();
      els.faceFront.focus();
    }
  }

  function move(delta) {
    var next = state.pos + delta;
    if (next < 0 || next >= state.queue.length) return;
    state.pos = next;
    state.revealed = false;
    renderCard();
    els.faceFront.focus();
  }

  function statTile(label, value, dot) {
    var box = Archway.el("div", "stat");
    box.appendChild(Archway.el("span", "stat__value", String(value)));

    var caption = Archway.el("span", "stat__label");
    if (dot) {
      var mark = Archway.el("span", "tally__dot tally__dot--" + dot);
      mark.setAttribute("aria-hidden", "true");
      caption.appendChild(mark);
    }
    caption.appendChild(document.createTextNode(label));
    box.appendChild(caption);
    return box;
  }

  function showSummary() {
    var secs = Math.round((Date.now() - state.startedAt) / 1000);
    var mins = Math.floor(secs / 60);
    var time = mins + "m " + (secs % 60) + "s";

    Archway.clear(els.summaryPanel);
    els.summaryPanel.appendChild(Archway.el("h2", "", "Session complete"));
    els.summaryPanel.appendChild(Archway.el("p", "summary__note",
      "You worked through " + state.queue.length + " cards, " + state.deck.length + " of them distinct. " +
      "Nothing is saved when this tab closes, so export the deck if you want it again."));

    var stats = Archway.el("div", "stats");
    stats.appendChild(statTile("Again", state.counts.again, "again"));
    stats.appendChild(statTile("Hard", state.counts.hard, "hard"));
    stats.appendChild(statTile("Good", state.counts.good, "good"));
    stats.appendChild(statTile("Time", time, ""));
    els.summaryPanel.appendChild(stats);

    var row = Archway.el("div", "row");
    var again = Archway.el("button", "btn btn--primary", "Review again");
    again.type = "button";
    again.addEventListener("click", function () {
      restart();
      els.faceFront.focus();
    });
    var toDeck = Archway.el("button", "btn btn--ghost", "See the whole deck");
    toDeck.type = "button";
    toDeck.addEventListener("click", function () { switchView("deck"); });
    row.appendChild(again);
    row.appendChild(toDeck);
    els.summaryPanel.appendChild(row);

    els.reviewPanel.classList.add("hidden");
    els.summaryPanel.classList.remove("hidden");
    els.summaryPanel.focus();
  }

  /* ---------- deck view ---------- */

  function renderDeckList() {
    Archway.clear(els.deckList);
    state.deck.forEach(function (card) {
      var row = Archway.el("div", "deck__row");
      row.appendChild(Archway.el("div", "deck__front", card.front));
      row.appendChild(Archway.el("div", "deck__back", card.back));
      row.appendChild(Archway.el("span", "badge deck__tag", card.tag));
      els.deckList.appendChild(row);
    });
  }

  function switchView(view) {
    state.view = view;
    var reviewing = view === "review";
    els.viewReview.setAttribute("aria-pressed", String(reviewing));
    els.viewDeck.setAttribute("aria-pressed", String(!reviewing));
    els.viewReview.className = "btn btn--sm" + (reviewing ? " btn--primary" : " btn--ghost");
    els.viewDeck.className = "btn btn--sm" + (reviewing ? " btn--ghost" : " btn--primary");

    els.deckPanel.classList.toggle("hidden", reviewing);
    var done = state.pos >= state.queue.length;
    els.reviewPanel.classList.toggle("hidden", !reviewing || done);
    els.summaryPanel.classList.toggle("hidden", !reviewing || !done);

    if (!reviewing) els.deckPanel.focus();
    else if (done) els.summaryPanel.focus();
    else els.faceFront.focus();
  }

  /* ---------- export ---------- */

  function csvField(v) {
    return '"' + String(v).replace(/"/g, '""') + '"';
  }

  function toCsv(cards) {
    // Anki 2.1.54+ reads these header lines and maps the columns itself; older
    // versions skip any line starting with '#'.
    var lines = ["#separator:Comma", "#html:false", "#tags column:3"];
    cards.forEach(function (c) {
      lines.push([csvField(c.front), csvField(c.back), csvField(c.tag)].join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  function toTsv(cards) {
    // A TSV field cannot contain a tab or a newline, so flatten them.
    function flat(v) { return String(v).replace(/[\t\r\n]+/g, " ").trim(); }
    return cards.map(function (c) {
      return [flat(c.front), flat(c.back), flat(c.tag)].join("\t");
    }).join("\r\n") + "\r\n";
  }

  function downloadCsv() {
    var blob = new Blob([toCsv(state.deck)], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "archway-flashcards-" + state.deck.length + "-cards.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    els.exportStatus.textContent = "Saved " + state.deck.length + " cards.";
  }

  function copyTsv() {
    els.copyTsv.disabled = true;
    spin(els.exportSpinner, true);
    els.exportStatus.textContent = "";
    Promise.resolve()
      .then(function () { return navigator.clipboard.writeText(toTsv(state.deck)); })
      .then(function () { els.exportStatus.textContent = "Copied " + state.deck.length + " rows."; })
      .catch(function () {
        els.exportStatus.textContent = "The browser blocked the clipboard \u2014 use the CSV instead.";
      })
      .finally(function () {
        els.copyTsv.disabled = false;
        spin(els.exportSpinner, false);
      });
  }

  /* ---------- events ---------- */

  els.sample.addEventListener("click", function () {
    els.notes.value = SAMPLE_NOTES;
    els.notes.focus();
  });
  els.generate.addEventListener("click", generate);
  els.stop.addEventListener("click", function () {
    if (state.controller) state.controller.abort();
  });

  els.reveal.addEventListener("click", reveal);
  els.gradeAgain.addEventListener("click", function () { grade("again"); });
  els.gradeHard.addEventListener("click", function () { grade("hard"); });
  els.gradeGood.addEventListener("click", function () { grade("good"); });
  els.prev.addEventListener("click", function () { move(-1); });
  els.next.addEventListener("click", function () { move(1); });
  els.flash.addEventListener("click", function () { if (!state.revealed) reveal(); });

  els.viewReview.addEventListener("click", function () { switchView("review"); });
  els.viewDeck.addEventListener("click", function () { switchView("deck"); });

  els.downloadCsv.addEventListener("click", downloadCsv);
  els.copyTsv.addEventListener("click", copyTsv);

  function isTyping(node) {
    if (!node) return false;
    var tag = node.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
  }

  document.addEventListener("keydown", function (ev) {
    if (!state.deck.length || state.view !== "review") return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (isTyping(ev.target)) return;
    if (state.pos >= state.queue.length) return;

    var onControl = ev.target && (ev.target.tagName === "BUTTON" || ev.target.tagName === "A");

    if (ev.key === " " || ev.key === "Spacebar") {
      if (onControl) return;               // let the focused button handle its own activation
      ev.preventDefault();
      reveal();
    } else if (ev.key === "1") {
      grade("again");
    } else if (ev.key === "2") {
      grade("hard");
    } else if (ev.key === "3") {
      grade("good");
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      move(-1);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      move(1);
    }
  });
})();
