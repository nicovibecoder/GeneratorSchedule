import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const required = ['GEMINI_API_KEY','FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','REGIONS','QUEST_PROMPT_TEMPLATE'];
const missing = required.filter(v => !process.env[v]);
if (missing.length) { process.stderr.write(`missing env: ${missing.join(',')}\n`); process.exit(1); }

const {
    GEMINI_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY, REGIONS, QUEST_PROMPT_TEMPLATE,
    GEMINI_MODEL = 'google/gemini-2.0-flash-lite:free',
    QUESTS_PER_REGION = '5',
} = process.env;
const RPM_LIMIT = 60; // OpenRouter is much more generous than Gemini free tier
const REGIONS_LIST = REGIONS.split(',').map(r => r.trim()).filter(Boolean);
const COUNT = parseInt(QUESTS_PER_REGION, 10);
const BASE_POINTS = { common:100, uncommon:200, rare:400, epic:700, legendary:1200 };

// Log startup info (not secrets)
process.stdout.write(`regions: ${REGIONS_LIST.length}, count/region: ${COUNT}, model: ${GEMINI_MODEL}\n`);
process.stdout.write(`template length: ${QUEST_PROMPT_TEMPLATE.length} chars\n`);

initializeApp({
    credential: cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
});
const db = getFirestore();

// Call OpenRouter with Gemini model (OpenAI-compatible API, no extra SDK needed)
async function callOpenRouter(prompt) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GEMINI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: GEMINI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        const err = new Error(`[${res.status}] ${body}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    if (!data.choices?.[0]?.message?.content) {
        throw new Error(`unexpected response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data.choices[0].message.content;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Rate limit constants (OpenRouter free tier: ~60 RPM) ---
// 1 request per region → 60000ms / 60 RPM = 1000ms minimum between requests
// Add buffer to stay safely under limit
                                   // requests per minute (free tier)
const DELAY_BETWEEN_REGIONS_MS = Math.ceil(60000 / RPM_LIMIT) + 2000; // ~6000ms per region
const MAX_RETRY_WAIT_MS = 90000;                             // cap retry wait at 90s
// --------------------------------------------------------------

/**
 * Parse retryDelay from Gemini 429 error message.
 * Error text contains e.g. "retryDelay":"31.5s" or "retryDelay":"49s"
 * Returns milliseconds, default 60000 if not found.
 */
function parseRetryDelay(errMsg) {
    const m = errMsg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
    if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 2000; // +2s buffer
    return 60000;
}

/**
 * Call Gemini with exponential backoff on 429.
 * MAX_RETRIES attempts, respecting the retryDelay from the API response.
 */
const MAX_RETRIES = 5;
async function genWithRetry(prompt) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await callOpenRouter(prompt);
            return result;
        } catch (e) {
            const is429 = e.message?.includes('429') || e.status === 429;
            if (!is429 || attempt === MAX_RETRIES) throw e;

            const delayMs = Math.min(parseRetryDelay(e.message ?? ''), MAX_RETRY_WAIT_MS);
            process.stdout.write(`  [rate-limit] attempt ${attempt}/${MAX_RETRIES}, waiting ${(delayMs/1000).toFixed(1)}s...\n`);
            await sleep(delayMs);
        }
    }
}

async function gen(region, dateStr, expiresAt) {
    const prompt = QUEST_PROMPT_TEMPLATE
        .replace(/\{\{region\}\}/g, region)
        .replace(/\{\{date\}\}/g, dateStr)
        .replace(/\{\{count\}\}/g, String(COUNT));

    const text = await genWithRetry(prompt);

    let arr;
    try {
        arr = JSON.parse(text);
    } catch {
        // Try to extract JSON array from response if wrapped in markdown or extra text
        const m = text.match(/\[[\s\S]*\]/);
        if (!m) throw new Error(`parse failed, response: ${text.slice(0, 200)}`);
        arr = JSON.parse(m[0]);
    }

    if (!Array.isArray(arr) || !arr.length) {
        throw new Error(`empty or non-array response: ${text.slice(0, 200)}`);
    }

    return arr.slice(0, COUNT + 2).map((q, i) => ({
        id: `quest_${dateStr}_${region.replace(/\s+/g, '_')}_${i}`,
        title: String(q.title ?? ''),
        description: String(q.description ?? ''),
        hint: String(q.hint ?? q.description ?? ''),
        category: String(q.category ?? 'object'),
        difficulty: String(q.difficulty ?? 'common'),
        // Fix: store as actual array, not JSON string
        targetLabels: Array.isArray(q.targetLabels) ? q.targetLabels.map(String) : [],
        basePoints: BASE_POINTS[q.difficulty] ?? 100,
        rarityMultiplier: Number(q.rarityMultiplier ?? 1),
        region,
        expiresAt: Timestamp.fromDate(expiresAt),
        createdAt: Timestamp.now(),
        generatedBy: 'ai',
        isSeasonalEvent: Boolean(q.isSeasonalEvent),
        eventName: q.eventName ?? null,
        eventBadge: q.eventBadge ?? null,
        eventMultiplier: q.eventMultiplier ?? null,
    }));
}

async function cleanup() {
    const snap = await db.collection('quests').where('expiresAt', '<', Timestamp.now()).get();
    if (snap.empty) { process.stdout.write('cleanup: no expired quests\n'); return; }
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    process.stdout.write(`cleanup: deleted ${snap.size} expired quests\n`);
}

async function main() {
    const dateStr = new Date().toISOString().split('T')[0];
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);

    await cleanup();

    const errors = [];
    for (const region of REGIONS_LIST) {
        try {
            process.stdout.write(`generating: ${region}...\n`);
            const quests = await gen(region, dateStr, tomorrow);
            const batch = db.batch();
            quests.forEach(q => batch.set(db.collection('quests').doc(q.id), q));
            await batch.commit();
            process.stdout.write(`  ok: ${quests.length} quests for ${region}\n`);
            // Rate limit buffer between regions to stay under RPM_LIMIT
            if (region !== REGIONS_LIST.at(-1)) {
                await sleep(DELAY_BETWEEN_REGIONS_MS);
            }
        } catch (e) {
            errors.push(region);
            process.stderr.write(`[FAIL] ${region}: ${e.message}\n`);
        }
    }

    if (errors.length) {
        process.stderr.write(`failed regions (${errors.length}/${REGIONS_LIST.length}): ${errors.join(', ')}\n`);
        process.exit(1);
    }

    process.stdout.write(`done: all ${REGIONS_LIST.length} regions generated\n`);
}

main().catch(e => {
    process.stderr.write(`fatal: ${e.message}\n${e.stack}\n`);
    process.exit(1);
});
