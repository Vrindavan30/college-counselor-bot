import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();



async function webSearch(q, opts = {}) {
  const { site, num = 5 } = opts;
  const key = process.env.GOOGLE_CSE_KEY;
  const cx  = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) {
    console.warn("⚠️ webSearch disabled: missing GOOGLE_CSE_KEY or GOOGLE_CSE_CX");
    return [];
  }

  const query = site ? `site:${site} ${q}` : q;
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${num}`;

  const r = await fetch(url);
  if (!r.ok) {
    console.warn(`⚠️ webSearch HTTP ${r.status} for`, { query, site });
    return [];
  }
  const data = await r.json();
  if (!Array.isArray(data.items)) {
    console.warn("⚠️ webSearch returned no items. Check CSE config (‘Search the entire web’), query:", { query, site });
  }
  return (data.items || []).map(it => ({
    title: it.title,
    link: it.link,
    snippet: it.snippet || "",
    displayLink: it.displayLink || ""
  }));
}

// put near your other helpers
function words(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}


function normSchool(s) {
  return (s||"").toLowerCase()
    .replace(/\b(community|college|university|dept|department|&|at)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNameSchoolFromTitle(title) {
  if (!title) return null;
  const patterns = [
    /^(.+?)\s+at\s+(.+?)\s+\|\s+Rate My Professors$/i,
    /^Professor Ratings?:\s*(.+?)\s*[–-]\s*(.+)$/i,
    /^(.+?)\s*[–-]\s*(.+?)\s*\|\s*Rate My Professors$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(title);
    if (m) return { name: m[1].trim(), school: m[2].trim() };
  }
  return null;
}

function looksLikeSameSchool(a, b) {
  const A = normSchool(a), B = normSchool(b);
  return A && B && (A.includes(B) || B.includes(A));
}

function extractCampusHint(s) {
  const q = (s || "").toLowerCase();
  if (/\bucsd|san diego\b/.test(q)) return "uc san diego";
  if (/\bucla|los angeles\b/.test(q)) return "ucla";
  if (/\bucsb|santa barbara\b/.test(q)) return "uc santa barbara";
  if (/\buci|irvine\b/.test(q)) return "uc irvine";
  if (/\bucd|davis\b/.test(q)) return "uc davis";
  if (/\bucsc|santa cruz\b/.test(q)) return "uc santa cruz";
  if (/\bucr|riverside\b/.test(q)) return "uc riverside";
  if (/\bucm|merced\b/.test(q)) return "uc merced";
  if (/\bberkeley|cal\b/.test(q)) return "uc berkeley";
  return null;
}

function isMajorReqQuery(s) {
  const q = (s || "").toLowerCase();
  const mentionsDS = /\b(data\s*science|data\s*theory|ds)\b/.test(q);
  const mentionsUC = /\b(uc|ucla|ucsd|ucsb|uci|ucd|ucsc|ucr|ucm|berkeley|irvine|davis|riverside|merced|santa\s*barbara|santa\s*cruz|san\s*diego)\b/.test(q);
  const asksReqs = /\b(requirement|requirements|prereq|prereqs|prerequisite|prerequisites|courses|course list|classes|curriculum|plan)\b/.test(q);
  return (mentionsDS && (mentionsUC || asksReqs));
}

async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-small", // cheap + good
      input: text
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.data[0].embedding;
}

function cosine(a, b) {
  let dot=0, na=0, nb=0;
  for (let i=0; i<a.length; i++) { dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

// ---- Load local school data (edit data/school.json) ----
let SCHOOL_DB = {};
try {
  const raw = fs.readFileSync("data/school.json", "utf-8");
  SCHOOL_DB = JSON.parse(raw);
  console.log(`📚 Loaded local KB for: ${SCHOOL_DB.school?.name || "Unknown School"}`);
} catch (e) {
  console.warn("⚠️ Could not load data/school.json. Local KB disabled.", e.message);
  SCHOOL_DB = { school: { name: "Unknown" }, deadlines: [], professors: [], courses: [], faq: [] };
}

// --- De-duplicate professors by normalized name and merge courses ---
if (Array.isArray(SCHOOL_DB.professors)) {
  const byName = new Map();
  for (const p of SCHOOL_DB.professors) {
    const key = (p.name || "").toLowerCase().trim();
    if (!key) continue;
    if (!byName.has(key)) {
      byName.set(key, { ...p, courses: Array.isArray(p.courses) ? [...new Set(p.courses)] : [] });
    } else {
      const base = byName.get(key);
      // merge courses
      const mergedCourses = new Set([
        ...(Array.isArray(base.courses) ? base.courses : []),
        ...(Array.isArray(p.courses) ? p.courses : [])
      ]);
      byName.set(key, {
        ...base,
        ...p, // later fields can update earlier ones
        courses: [...mergedCourses]
      });
    }
  }
  SCHOOL_DB.professors = Array.from(byName.values());
}

// ---- Tiny in-memory session (single-user dev) ----
let SESSION = {
  lastCourse: null,          // e.g., "MATH 1A"
  lastProfessor: null,       // the most recently suggested prof name
  rankCursor: {}             // { "MATH 1A": 0 } -> index into rankings list (0-based)
};

// ---- Build embedding index from SCHOOL_DB ----
let EMB_INDEX = []; // [{type, data, text, emb}]

async function buildIndex() {
  try {
    const items = [];

    (SCHOOL_DB.deadlines||[]).forEach(d => {
      items.push({
        type: "deadline",
        data: d,
        text: `Deadline | ${d.term} | ${d.category} | ${d.description} | ${d.date} ${d.time||""} | ${d.notes||""} | ${(d.keywords||[]).join(" ")}`
      });
    });

    (SCHOOL_DB.professors||[]).forEach(p => {
      items.push({
        type: "professor",
        data: p,
        text: `Professor | ${p.name} | ${p.department} | ${(p.courses||[]).join(", ")} | rating ${p.rating||""} | ${p.reviews||""}`
      });
    });

    (SCHOOL_DB.courses||[]).forEach(c => {
      items.push({
        type: "course",
        data: c,
        text: `Course | ${c.code} | ${c.title} | ${c.department} | ${c.description||""} | ${c.notes||""}`
      });
    });

    (SCHOOL_DB.faq||[]).forEach(f => {
      items.push({
        type: "faq",
        data: f,
        text: `FAQ | ${f.q} | ${f.a} | ${(f.keywords||[]).join(" ")}`
      });
    });

    (SCHOOL_DB.majors || []).forEach(m => {
      const lower = m.lower_division || [];
      const upper = m.upper_division || [];
      const text = [
        "Major",
        m.campus,
        m.program,
        (m.aliases || []).join(" "),
        "Lower:", lower.join(" ; "),
        "Upper:", upper.join(" ; "),
        m.notes || ""
      ].join(" | ");
      items.push({ type: "major", data: m, text });
    });

    EMB_INDEX = [];
    for (const it of items) {
      const emb = await embed(it.text);
      EMB_INDEX.push({ ...it, emb });
    }
    console.log(`🧠 Built embedding index with ${EMB_INDEX.length} items`);
  } catch (e) {
    console.warn("⚠️ Embedding index build failed:", e.message);
  }
}
buildIndex();

// ---- Simple local search over your KB ----
function normalize(s) { return (s || "").toLowerCase(); }

// extract things like "MATH 1A", "CIS 22B", with or without space
function extractCourseCodes(text) {
  const t = text.toUpperCase();
  // e.g. CIS22B, CIS 22B, MATH1A, MATH 1A
  const re = /\b([A-Z]{2,5})\s?(\d{1,3}[A-Z]?)\b/g;
  const out = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    out.push(`${m[1]} ${m[2]}`.trim());
  }
  return Array.from(new Set(out));
}

// very light department extraction (customize as you like)
function extractDeptHint(text) {
  const t = normalize(text);
  if (t.includes("math")) return "mathematics";
  if (t.includes("cs") || t.includes("computer science") || t.includes("cis")) return "computer science";
  if (t.includes("physics")) return "physics";
  if (t.includes("chem")) return "chemistry";
  return null;
}

function scoreItem(query, text) {
  const q = normalize(query);
  const t = normalize(text || "");
  if (!q || !t) return 0;
  let score = 0;

  // keyword overlap
  q.split(/\W+/).filter(Boolean).forEach(word => {
    if (t.includes(word)) score += 1;
  });
  // position bonus
  if (t.startsWith(q)) score += 2;
  return score;
}

function canonCourse(s) {
  return (s || "").toUpperCase().replace(/[\s-]+/g, " ").trim(); // normalize
}

// === Valid course codes (built once from courses + rankings) ===
let VALID_CODES = new Set();
function computeValidCodes() {
  VALID_CODES = new Set([
    ...((SCHOOL_DB.courses || []).map(c => canonCourse(c.code))),
    ...Object.keys(SCHOOL_DB.rankings || {}).map(canonCourse),
  ]);
  console.log("✅ Valid course codes:", [...VALID_CODES].join(", "));
}
computeValidCodes();

function resolveCourseAlias(text) {
  const s = (text || "").toLowerCase();
  if (/\b(calculus\s*i|calc\s*i|math\s*1a)\b/.test(s)) return "MATH 1A";
  if (/\b(calculus\s*ii|calc\s*ii|math\s*1b)\b/.test(s)) return "MATH 1B";
  if (/\b(calculus\s*iii|calc\s*iii|math\s*1c)\b/.test(s)) return "MATH 1C";
  return null;
}

function parseRankIntent(query) {
  const q = query.toLowerCase();
  const wantBest = /best\s+(prof|professor)/.test(q) || /\btop\b/.test(q);
  const wantSecond = /(second|2nd)\s+best/.test(q);
  const wantEasiest = /\beasiest\b/.test(q);
  const wantTeach = /(best\s+teaching|teaches\s+best|best\s+teacher)/.test(q);
  let tags = [];
  if (wantSecond) tags.push("second_best");
  if (wantEasiest) tags.push("easiest");
  if (wantTeach) tags.push("best_teaching");
  if (!tags.length && wantBest) tags.push("best_overall"); // default “best”
  return { tags, asked: wantBest || wantSecond || wantEasiest || wantTeach };
}

function detectIntent(q) {
  const s = (q || "").toLowerCase();
  const w = words(q);

  // full-name mention
  const names = (SCHOOL_DB.professors || []).map(p => p.name).filter(Boolean);
  const fullMention = names.find(n => s.includes(n.toLowerCase()));

  // NEW: last-name mention (whole-word)
  let lastNameMention = null;
  if (!fullMention && w.length) {
    const lastNameMap = new Map(); // last -> array of profs
    for (const p of (SCHOOL_DB.professors || [])) {
      const parts = (p.name || "").toLowerCase().split(/\s+/);
      if (!parts.length) continue;
      const last = parts[parts.length - 1];
      if (!lastNameMap.has(last)) lastNameMap.set(last, []);
      lastNameMap.get(last).push(p);
    }
    for (const token of w) {
      if (lastNameMap.has(token)) {
        lastNameMention = token;
        break;
      }
    }
  }

  if (isMajorReqQuery(s)) return "major_requirements";
  if (/(best|top|easiest)\s+(prof|professor)/.test(s)) return "prof_ranking";
  if (fullMention || lastNameMention) return "prof_lookup";   // ← key change
  if (/\b(waitlist|full|closed|no seats|class is full)\b/.test(s)) return "class_full";
  if (/\b(tutor|tutoring|stem center|writing center)\b/.test(s)) return "tutoring";
  if (/\b(deadline|last day|drop|withdraw|add|calendar)\b/.test(s)) return "deadline";
  if (/\bwho should i take\b/.test(s) && SESSION.lastCourse) return "class_full";
  return "generic";
}


async function searchLocalKB(query) {
  const hits = [];
  let courseCodesInQuery = extractCourseCodes(query).map(canonCourse);
  let alias = null;
  if (courseCodesInQuery.length === 0) {
    alias = resolveCourseAlias(query);
    if (alias) courseCodesInQuery = [canonCourse(alias)];
  }

   // NEW: if we did find codes but none are actually in our DB, try alias
   if (
    courseCodesInQuery.length > 0 &&
    !courseCodesInQuery.some(c => VALID_CODES.has(c))
  ) {
    alias = resolveCourseAlias(query);
    if (alias) courseCodesInQuery = [canonCourse(alias)];
  }

  const deptHint = extractDeptHint(query);
  const qNorm = normalize(query);

  console.log("🔎 courseCodesInQuery:", courseCodesInQuery);

  // 🔎 If the user mentioned a professor by name, return only that professor
  const profNames = (SCHOOL_DB.professors || []).map(p => p.name);
  const mentioned = profNames.filter(name => qNorm.includes(normalize(name)));
  if (mentioned.length > 0) {
    const exactMatches = (SCHOOL_DB.professors || []).filter(p =>
      mentioned.some(m => normalize(p.name) === normalize(m))
    );
    if (exactMatches.length > 0) {
      SESSION.lastProfessor = exactMatches[0].name; // remember who the user is focused on
      return exactMatches.map(p => ({
        type: "professor",
        score: 100,
        data: p
      }));
    }
  }

  // --- NEW: fallback to last-name match if no exact full-name hit ---
  if (!mentioned.length) {
    const qWords = qNorm.split(/\s+/);
    const profMatches = (SCHOOL_DB.professors || []).filter(p => {
      const parts = p.name.toLowerCase().split(/\s+/);
      const last = parts[parts.length - 1]; // last word of prof name
      return qWords.includes(last);
    });
    if (profMatches.length > 0) {
      SESSION.lastProfessor = profMatches[0].name;
      return profMatches.map(p => ({
        type: "professor",
        score: 90,
        data: p
      }));
    }
  }

  // 🔝 1) RANKINGS FIRST
  const { tags: wantTags, asked } = parseRankIntent(query);
  if (asked && courseCodesInQuery.length > 0) {
    const code = courseCodesInQuery[0];
    const list = (SCHOOL_DB.rankings?.[code] || [])
      .slice()
      .sort((a, b) => (a.rank || 999) - (b.rank || 999));

    const matches = wantTags.length
      ? list.filter(item => (item.tags || []).some(t => wantTags.includes(t)))
      : list;

    const chosen = (matches.length ? matches : list).slice(0, 3);

    // Remember the course for downstream logic (e.g., class_full handoff),
    // even if we don’t find any rankings.
    SESSION.lastCourse = code;
    SESSION.rankCursor[code] = 0;

    if (chosen.length > 0) {
      if (chosen[0]?.name) SESSION.lastProfessor = chosen[0].name;

      for (const r of chosen) {
        const prof = (SCHOOL_DB.professors || [])
          .find(p => normalize(p.name) === normalize(r.name));

        const merged = {
          name: r.name,
          department: prof?.department || "(dept)",
          rating: prof?.rating ?? null,
          num_ratings: prof?.num_ratings ?? null,
          rmp_url: prof?.rmp_url || "",
          courses: prof?.courses || [code],
          review_or_notes: r.notes || prof?.reviews || ""
        };

        hits.push({
          type: "ranking",
          score: 100 - ((r.rank || 99) * 2),
          data: { course: code, tags: r.tags || [], rank: r.rank || null, prof: merged }
        });
      }

      const courseItem = (SCHOOL_DB.courses || []).find(c => canonCourse(c.code) === code);
      if (courseItem) hits.push({ type: "course", score: 0, data: courseItem });

      // ✅ Only return early if we actually found at least one ranked prof
      return hits.slice(0, 3);
    }

    // ❎ No rankings for this course -> do NOT return here.
    // Let the function fall through to embeddings/keyword search and finally the 🌐 web fallback.
  }

  // 🔍 2) SEMANTIC SEARCH (embeddings) as primary fallback
  if (EMB_INDEX.length > 0) {
    try {
      const queryEmb = await embed(query);
      const sims = EMB_INDEX.map(it => ({ it, sim: cosine(queryEmb, it.emb) }))
                            .sort((a,b) => b.sim - a.sim);

      const MIN_SIM = 0.78; // tweak threshold
      const top = sims.filter(s => s.sim >= MIN_SIM).slice(0, 3);

      if (top.length > 0) {
        console.log("🧠 Embedding hits:", top.map(t => ({ type: t.it.type, sim: t.sim.toFixed(3) })));
        const embHits = top.map(s => ({
          type: s.it.type,
          score: Math.round(100 * s.sim),
          data: s.it.data
        }));
        return embHits; // ✅ confident semantic match
      }
    } catch (e) {
      console.warn("⚠️ Embedding search failed:", e.message);
      // fall through to keyword fallback
    }
  }

  const pushHits = (arr, type, toBlob, extraScorer) => {
    for (const item of arr || []) {
      const blob = toBlob(item);
      let s = scoreItem(query, blob);

      if (extraScorer) s += extraScorer(item, qNorm, courseCodesInQuery, deptHint);

      if (s > 0) hits.push({ type, score: s, data: item });
    }
  };

  // Deadlines
  pushHits(
    SCHOOL_DB.deadlines,
    "deadline",
    d => `${d.term} ${d.category} ${d.description} ${d.date} ${d.time || ""} ${d.notes || ""} ${(d.keywords || []).join(" ")}`,
    null
  );

  // Professors — heavily boost exact course code and department matches
  pushHits(
    SCHOOL_DB.professors,
    "professor",
    p => `${p.name} ${p.department} ${(p.courses || []).join(" ")} ${p.rating} ${p.reviews || ""}`,
    (p, _q, courseCodes, dept) => {
      let bonus = 0;
      const profCourses = (p.courses || []).map(c => c.toUpperCase().replace(/[\s-]+/g, " ").trim());

      // strong boost for exact course match(es)
      for (const code of courseCodes) {
        const normCode = code.toUpperCase().replace(/[\s-]+/g, " ").trim();
        if (profCourses.includes(normCode)) bonus += 8;   // big boost
      }

      // moderate boost if dept matches user hint
      if (dept && normalize(p.department) === dept) bonus += 3;

      // slight penalty if user asked for a "best professor for X" and this prof doesn't teach X
      if (courseCodes.length > 0) {
        const teachesRequested = courseCodes.some(code =>
          profCourses.includes(code.toUpperCase().replace(/[\s-]+/g, " ").trim())
        );
        if (!teachesRequested) bonus -= 4; // push irrelevant profs down
      }

      return bonus;
    }
  );

  // Courses — boost if query contains the exact course code
  pushHits(
    SCHOOL_DB.courses,
    "course",
    c => `${c.code} ${c.title} ${c.department} ${c.description || ""} ${c.notes || ""}`,
    (c, _q, courseCodes) => {
      let bonus = 0;
      const normCode = (c.code || "").toUpperCase().replace(/\s+/, " ").trim();
      for (const code of courseCodes) {
        if (normCode === code.toUpperCase().replace(/\s+/, " ").trim()) bonus += 6;
      }
      return bonus;
    }
  );

  // FAQ
  pushHits(
    SCHOOL_DB.faq,
    "faq",
    f => `${f.q} ${f.a} ${(f.keywords || []).join(" ")}`,
    null
  );

  // If user explicitly asked "best professor for <course>", prefer professors first
    // If user explicitly asked "best professor for <course>", prefer professors first
    const askedBestProfForCourse =
    /(best\s+(prof|professor))/i.test(query) && courseCodesInQuery.length > 0;

  hits.sort((a, b) => {
    if (askedBestProfForCourse && a.type !== b.type) {
      if (a.type === "professor") return -1;
      if (b.type === "professor") return 1;
    }
    return b.score - a.score;
  });

  // 🔒 HARD FILTER MODE:
  // If the user asked "best professor for <course>", keep ONLY professors who teach that course,
  // plus at most one matching course card. No unrelated professors.
  if (askedBestProfForCourse) {
    const profThatTeach = hits.filter(h => h.type === "professor").filter(h => {
      const profCourses = (h.data.courses || []).map(c => c.toUpperCase().replace(/\s+/, " ").trim());
      return courseCodesInQuery.some(code =>
        profCourses.includes(code.toUpperCase().replace(/\s+/, " ").trim())
      );
    });

    // If we have any matching professors, return them (cap at 2) + 1 course card
    if (profThatTeach.length > 0) {
      const courseCard = hits.find(h => h.type === "course");
      const out = [...profThatTeach.slice(0, 2)];
      if (courseCard) out.push(courseCard);
      return out.slice(0, 3);
    }
    // If somehow no professor matches the course, fall through to generic top-3 (graceful)
  }

  // --- Major requirements matching (local KB) ---
  const majorHits = [];
  const campusHint = extractCampusHint(query);
  const wantsMajor = isMajorReqQuery(query);

  if (wantsMajor && (SCHOOL_DB.majors || []).length) {
    for (const m of SCHOOL_DB.majors) {
      let score = 0;
      // Campus match
      if (campusHint) {
        if (m.campus.toLowerCase().includes(campusHint.replace(/^uc /, "uc ").toLowerCase())) score += 10;
        const synonyms = {
          "ucsd": "uc san diego",
          "ucla": "ucla",
          "ucsb": "uc santa barbara",
          "uci": "uc irvine",
          "ucd": "uc davis",
          "ucsc": "uc santa cruz",
          "ucr": "uc riverside",
          "ucm": "uc merced"
        };
        for (const k in synonyms) {
          if (campusHint === k && m.campus.toLowerCase() === synonyms[k]) score += 10;
        }
      }
      
      const blob = [
        m.program,
        (m.aliases || []).join(" "),
        (m.lower_division || []).join(" "),
        (m.upper_division || []).join(" ")
      ].join(" ").toLowerCase();


      if (/\bdata\s*science\b/.test(blob)) score += 4;
      if (/\bdata\s*theory\b/.test(blob)) score += 2;

      // Loose keyword overlap
      const words = query.toLowerCase().split(/\W+/).filter(Boolean);
      for (const w of words) if (blob.includes(w)) score += 0.3;

      if (score > 0) majorHits.push({ type: "major", score, data: m });
    }

    if (majorHits.length) {
      majorHits.sort((a,b) => b.score - a.score);
      return majorHits.slice(0, 3);
    }
  }

  // 🌐 --- Web fallback: try Google CSE if we found no prof hits ---
  const needProfButEmpty =
  (hits.length === 0 || !hits.some(h => h.type === "ranking" || h.type === "professor"));

  if (needProfButEmpty && /(best|top|easiest)\s+(prof|professor)/i.test(query)) {
  const course = (courseCodesInQuery[0] || "").trim();
  const school = SCHOOL_DB.school?.name || "";

  const qWeb = [course, school].filter(Boolean).join(" ");

  // Query RateMyProfessors
  const rmpResults = await webSearch(`${qWeb} Rate My Professors`, {
    site: "ratemyprofessors.com",
    num: 10
  });

  // Query school site as well
  const schoolHost = (SCHOOL_DB.school?.website || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "") || "deanza.edu";

  const siteQuerys = [
    `${qWeb} instructor`,
    `${qWeb} syllabus`,
    `${qWeb} schedule`,
    `${qWeb} department`
  ];

  let schoolResults = [];
  for (const sq of siteQuerys) {
    const batch = await webSearch(sq, { site: schoolHost, num: 5 });
    schoolResults.push(...batch);
  }

  // Collect candidate names from RMP titles
  const candidates = [];
  for (const it of rmpResults) {
    const parsed = extractNameSchoolFromTitle(it.title || "");
    if (parsed && looksLikeSameSchool(parsed.school, school)) {
      candidates.push({ name: parsed.name, source: "rmp", url: it.link });
    }
  }

  // Also try to yank names from school site titles like "CIS 36A — Alice Chen"
  const nameLike = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g; // naive: “Firstname Lastname”
  for (const it of schoolResults) {
    const title = it.title || "";
    let m;
    while ((m = nameLike.exec(title)) !== null) {
      const n = m[1].trim();
      if (n.split(" ").length >= 2) {
        candidates.push({ name: n, source: "school", url: it.link });
      }
    }
  }

  // Deduplicate by name
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const key = c.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  // If we found any names, return the top few as "ranking" hits
  if (unique.length) {
    for (const c of unique.slice(0, 3)) {
      hits.push({
        type: "ranking",
        score: c.source === "rmp" ? 92 : 85,
        data: {
          course: course || "(unknown course)",
          tags: ["web_result"],
          rank: null,
          prof: {
            name: c.name,
            department: "(unknown)",
            rating: null,
            num_ratings: null,
            rmp_url: c.source === "rmp" ? c.url : "",
            courses: course ? [course] : [],
            review_or_notes: ""
          }
        }
      });
    }
    return hits.slice(0, 3);
  }

  // If still nothing, drop a helpful links card
  const topLinks = [...rmpResults, ...schoolResults].slice(0, 5);
  if (topLinks.length) {
    hits.push({
      type: "faq",
      score: 80,
      data: {
        q: `Web results for ${course || "the course"}`,
        a: topLinks
          .map((t, i) => `${i + 1}. ${t.title}\n   ${t.link}\n   ${t.snippet || ""}`)
          .join("\n")
      }
    });
    return hits.slice(0, 3);
  }
}

  return hits.slice(0, 3);
}

function formatHit(hit) {
  if (hit.type === "deadline") {
    const d = hit.data;
    return `🗓️ ${d.term} — ${d.category}\n• ${d.description}\n• Date: ${d.date}${d.time ? " " + d.time : ""}${d.notes ? "\n• Notes: " + d.notes : ""}`;
  }
  if (hit.type === "professor") {
    const p = hit.data;
    const rmp = p.rmp_url ? `\n• RMP: ${p.rmp_url}` : "";
    const teaches = (p.courses && p.courses.length) ? `\n• Teaches: ${p.courses.join(", ")}` : "";
    return `👩‍🏫 ${p.name} — ${p.department}\n• Rating: ${p.rating || "N/A"}${p.num_ratings ? ` (${p.num_ratings} ratings)` : ""}${teaches}${rmp}`;
  }
  if (hit.type === "course") {
    const c = hit.data;
    return `📘 ${c.code}: ${c.title}\n• Dept: ${c.department}${c.description ? `\n• About: ${c.description}` : ""}${c.notes ? `\n• Notes: ${c.notes}` : ""}`;
  }
  if (hit.type === "faq") {
    const f = hit.data;
    return `❓ ${f.q}\n✅ ${f.a}`;
  }
  if (hit.type === "ranking") {
    const r = hit.data;
    const p = r.prof;
    const tagLabel = (r.tags || []).join(", ") || "ranked";
    const rmp = p.rmp_url ? `\n• RMP: ${p.rmp_url}` : "";
    const rating = (p.rating != null) ? `• Rating: ${p.rating}${p.num_ratings ? ` (${p.num_ratings} ratings)` : ""}\n` : "";
    const teaches = p.courses?.length ? `• Teaches: ${p.courses.join(", ")}\n` : "";
    const notes = p.review_or_notes ? `• Notes: ${p.review_or_notes}\n` : "";
    const rankline = (r.rank != null) ? `#${r.rank} ` : "";
    return `🏆 ${rankline}${p.name} — ${p.department}\n• Course: ${r.course}\n• Tag: ${tagLabel}\n${rating}${teaches}${notes}${rmp}`.trim();
  }
  
  if (hit.type === "major") {
    const m = hit.data;
    const lower = (m.lower_division || []).map(x => `• ${x}`).join("\n");
    const upper = (m.upper_division || []).map(x => `• ${x}`).join("\n");
    const link  = m.source_url ? `\n🔗 Source: ${m.source_url}` : "";
    const notes = m.notes ? `\n📝 Notes: ${m.notes}` : "";
  
    return `🎓 ${m.campus} — ${m.program}
  
  **Lower Division (community college prep — articulates to UC upper-division):**
  ${lower || "—"}
  
  **Upper Division (completed at ${m.campus} after transfer):**
  ${upper || "—"}${notes}${link}`;
  }
  return "";
}

// ---- Chat endpoint: always answer with OpenAI, using local KB as context ----
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    console.log("📩 User asked:", userMessage);

    // 1) Pull top KB snippets
    // 1) Pull top KB snippets
    const hits = await searchLocalKB(userMessage) || [];

    // 🔎 Intent detection + filtering
    const intent = detectIntent(userMessage);
    const allowByIntent = {
      prof_ranking: new Set(["ranking","professor","course"]),
      prof_lookup:  new Set(["professor","course"]),
      class_full:   new Set(["ranking","faq","deadline"]),
      tutoring:     new Set(["faq","course","deadline"]),
      deadline:     new Set(["deadline","faq"]),
      major_requirements: new Set(["major","faq","course"]),
      generic:      new Set(["professor","course","faq"]) // ← add at least "professor"
    };
    const allowed = allowByIntent[intent] || allowByIntent.generic;
    let filteredHits = hits.filter(h => allowed.has(h.type));


    // allow FAQ only if we found no prof/ranking for prof_ranking intent
    if (intent === "prof_ranking" && !filteredHits.some(h => h.type === "professor" || h.type === "ranking")) {
      filteredHits = hits.filter(h => allowed.has(h.type) || h.type === "faq");
    }

    // --- NEXT-BEST HANDOFF (deterministic short-circuit) ---
    if (intent === "class_full" && SESSION.lastCourse) {
      const course = SESSION.lastCourse;

      // ranked list for the course
      const list = (SCHOOL_DB.rankings?.[course] || [])
        .slice()
        .sort((a,b) => (a.rank ?? 999) - (b.rank ?? 999));

      if (list.length > 0) {
        // 1) Where are we now?
        const current = Number.isInteger(SESSION.rankCursor[course])
          ? SESSION.rankCursor[course]
          : 0;

        // 2) Move to the next one (after the last suggested name, if any)
        let nextIndex = current + 1;

        if (SESSION.lastProfessor) {
          const idx = list.findIndex(
            r => (r.name || "").toLowerCase() === SESSION.lastProfessor.toLowerCase()
          );
          if (idx >= 0) nextIndex = idx + 1;
        }

        // 3) Pick the next best
        const nextBest = list[nextIndex];

        // 4) If no next professor, we’re out of names — exit gracefully
        if (!nextBest) {
          const addDrop =
            (SCHOOL_DB.deadlines || []).find(d => /add/i.test(d.category))?.date ||
            "the add deadline";
          return res.json({
            reply:
              `I’ve listed everyone I have for ${course}. At this point: ` +
              `join the waitlist (if offered), email the instructor for an add code, ` +
              `and check ${addDrop}.`
          });
        }

        // 5) We have a next professor — look up full details
        const prof = (SCHOOL_DB.professors || []).find(
          p => p.name.toLowerCase() === (nextBest.name || "").toLowerCase()
        );

        // 6) Advance the cursor & remember this suggestion
        SESSION.rankCursor[course] = nextIndex;
        SESSION.lastProfessor = nextBest.name;

        // 7) Build a deterministic reply (no model guesswork)
        const ratingStr =
          (prof?.rating != null)
            ? ` (rating ${prof.rating}${prof.num_ratings ? `, ${prof.num_ratings} ratings` : ""})`
            : "";
        const rmpStr = prof?.rmp_url ? `\n• RMP: ${prof.rmp_url}` : "";
        const notes = nextBest.notes || prof?.reviews || "";

        return res.json({
          reply:
            `Next best for ${course} is **${nextBest.name}** — ${prof?.department || "(dept)"}${ratingStr}.` +
            (notes ? `\n• Notes: ${notes}` : "") +
            rmpStr +
            `\n\nIf the class is full: join the waitlist (if offered), email the instructor for an add code, and check the add/drop deadline.`
        });
      }
    }

    // Always add a second-best rec for the last course when class is full.
    // Put it FIRST so the model uses it.
    // If the class is full, FIRST suggest the next-best professor after the one we last suggested,
    // then let deadlines/FAQ follow.
    if (intent === "class_full" && SESSION.lastCourse) {
      const list = (SCHOOL_DB.rankings?.[SESSION.lastCourse] || []).slice()
        .sort((a,b) => (a.rank ?? 999) - (b.rank ?? 999));

      let nextBest = null;

      if (SESSION.lastProfessor) {
        const idx = list.findIndex(r => (r.name || "").toLowerCase() === SESSION.lastProfessor.toLowerCase());
        if (idx >= 0) nextBest = list[idx + 1] || null;
      }

      // Fallbacks: explicit tag, rank 2, or the #2 slot
      if (!nextBest) {
        nextBest = list.find(r => (r.tags || []).includes("second_best"))
                  || list.find(r => r.rank === 2)
                  || list[1]
                  || null;
      }

      if (nextBest) {
        const alreadyHas = filteredHits.some(h =>
          h.type === "ranking" &&
          h.data?.prof?.name?.toLowerCase() === (nextBest.name || "").toLowerCase()
        );

        if (!alreadyHas) {
          const prof = (SCHOOL_DB.professors || []).find(
            p => p.name.toLowerCase() === (nextBest.name || "").toLowerCase()
          );
          const merged = {
            name: nextBest.name,
            department: prof?.department || "(dept)",
            rating: prof?.rating ?? null,
            num_ratings: prof?.num_ratings ?? null,
            rmp_url: prof?.rmp_url || "",
            courses: prof?.courses || [SESSION.lastCourse],
            review_or_notes: nextBest.notes || prof?.reviews || ""
          };

          // put NEXT BEST first so the model uses it
          filteredHits.unshift({
            type: "ranking",
            score: 96,
            data: {
              course: SESSION.lastCourse,
              tags: nextBest.tags || ["second_best"],
              rank: nextBest.rank || 2,
              prof: merged
            }
          });

          // update memory: we just suggested this one now
          SESSION.lastProfessor = nextBest.name;
        }
      }
    }

    // Build context snippets (NO fallback—if nothing passes filter, send none)
    const maxSnippets = 5;
    const usedHits = filteredHits.slice(0, maxSnippets);
    const contextSnippets = usedHits
      .map((h, i) => {
        const txt = formatHit(h);
        return `Snippet ${i + 1} [${h.type}]:\n${txt.length > 600 ? txt.slice(0, 600) + "..." : txt}`;
      })
      .join("\n\n");

    // Optional debug:
    console.log("🎯 intent:", intent, " | hits:", hits.length, " | filtered:", usedHits.length);

    const hasProfSnippet = usedHits.some(h => h.type === "ranking" || h.type === "professor");
    const antiMakeup = (!hasProfSnippet && intent === "prof_ranking")
      ? 'Important: Do NOT invent professor names. Only recommend names present in the context snippets. If none are present, say we don’t have that info and ask for the exact course code (e.g., "MATH 1A").'
      : '';

   

    // 2) Ask OpenAI, grounding with snippets
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.5,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content: `You are a concise, accurate campus assistant.
        
        Rules:
        1)Never recommend a professor by name unless that name appears in the provided context snippets.
        2) If intent is "class_full" and a previous turn selected a professor for a course, first suggest the next best ranked professor by name (if available), then mention deadlines/waitlist steps.
        3) Do NOT paste the context snippets verbatim or list them back.
        4) First, answer the user's question in 1–3 sentences.
        5) Then, if helpful, add at most 2 short supporting bullets from the snippets.
        6) Ignore any snippet that is not clearly relevant.
        7) If the snippets don't contain the answer, say so briefly and give practical next steps (e.g., waitlist options, email instructor, check add/drop date, tutoring center link).`
            
          },
          ...(antiMakeup ? [{ role: "system", content: antiMakeup }] : []),
          { role: "system", content: `If intent is "class_full", recommend the next-best ranked professor for the last discussed course first (by name), then mention practical steps (waitlist, email instructor, add/drop date).` },
          { role: "system", content: `Detected intent: ${intent}` }, // <— add this
          ...(contextSnippets ? [{ role: "system", content: `Context:\n${contextSnippets}` }] : []),
          { role: "user", content: userMessage }
        ]
      })
    });

    const data = await response.json();
    console.log("✅ API response (usage or error):", JSON.stringify(data.usage || data.error || { ok: true }, null, 2));

    if (data.error) {
      console.error("❌ OpenAI API error:", data.error);
      return res.json({ reply: "Oops! API error: " + data.error.message });
    }

    // 3) Always return the AI answer
    res.json({ reply: data.choices[0].message.content });

  } catch (err) {
    console.error("❌ Server error:", err);
    res.status(500).json({ reply: "Something went wrong on the server." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));

