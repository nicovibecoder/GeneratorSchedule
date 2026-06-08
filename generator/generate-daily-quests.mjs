import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const required = ['GEMINI_API_KEY','FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','REGIONS','QUEST_PROMPT_TEMPLATE','GEMINI_MODEL'];
const missing = required.filter(v => !process.env[v]);
if (missing.length) { process.stderr.write(`missing env: ${missing.join(',')}\n`); process.exit(1); }

const {
    GEMINI_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY, REGIONS, QUEST_PROMPT_TEMPLATE,
    GEMINI_MODEL,
    QUESTS_PER_REGION = '5',
} = process.env;
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

// Call OpenRouter — single request for ALL regions at once
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
            max_tokens: 16000, // 16 regions × 5 quests needs more room
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'all_quests',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            regions: {
                                type: 'object',
                                additionalProperties: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            title:            { type: 'string' },
                                            description:      { type: 'string' },
                                            hint:             { type: 'string' },
                                            category:         { type: 'string' },
                                            difficulty:       { type: 'string', enum: ['common','uncommon','rare','epic','legendary'] },
                                            targetLabels:     { type: 'array', items: { type: 'string' } },
                                            rarityMultiplier: { type: 'number' },
                                            isSeasonalEvent:  { type: 'boolean' },
                                            eventName:        { type: ['string', 'null'] },
                                            eventBadge:       { type: ['string', 'null'] },
                                            eventMultiplier:  { type: ['number', 'null'] },
                                        },
                                        required: ['title','description','hint','category','difficulty','targetLabels','rarityMultiplier','isSeasonalEvent'],
                                        additionalProperties: false,
                                    },
                                },
                            },
                        },
                        required: ['regions'],
                        additionalProperties: false,
                    },
                },
            },
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        const err = new Error(`[${res.status}] ${body}`);
        err.status = res.status;
        throw err;
    }
    const rawText = await res.text();
    if (!rawText) throw new Error(`empty response body (status ${res.status})`);

    let data;
    try {
        data = JSON.parse(rawText);
    } catch (e) {
        throw new Error(`response not valid JSON (${rawText.length} chars): ${rawText.slice(0, 200)}`);
    }
    if (!data.choices?.[0]?.message?.content) {
        throw new Error(`unexpected response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const content = data.choices[0].message.content;
    const actualModel = data.model ?? GEMINI_MODEL;
    process.stdout.write(`  [debug] model: ${actualModel}, response length: ${content.length}\n`);
    return { content, actualModel };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Rate limit constants (kept for reference, parallel mode handles concurrency via retry) ---
const MAX_RETRY_WAIT_MS = 90000; // cap retry wait at 90s
// --------------------------------------------------------------

/**
 * Parse retryDelay from Gemini 429 error message.
 * Error text contains e.g. "retryDelay":"31.5s" or "retryDelay":"49s"
 * Returns milliseconds, default 60000 if not found.
 */
function parseRetryDelay(errMsg) {
    // OpenRouter 429 includes retry_after_seconds in metadata
    const orMatch = errMsg.match(/"retry_after_seconds"\s*:\s*([\d.]+)/);
    if (orMatch) return Math.ceil(parseFloat(orMatch[1]) * 1000) + 2000;
    // Gemini-style retryDelay
    const geminiMatch = errMsg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
    if (geminiMatch) return Math.ceil(parseFloat(geminiMatch[1]) * 1000) + 2000;
    return 30000; // default 30s
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
            const is502 = e.message?.includes('502') || e.status === 502;
            if ((!is429 && !is502) || attempt === MAX_RETRIES) throw e;

            const delayMs = is429
                ? Math.min(parseRetryDelay(e.message ?? ''), MAX_RETRY_WAIT_MS)
                : 5000 * attempt; // 502: 5s, 10s, 15s...
            process.stdout.write(`  [rate-limit] attempt ${attempt}/${MAX_RETRIES}, waiting ${(delayMs/1000).toFixed(1)}s...\n`);
            await sleep(delayMs);
        }
    }
}

async function genAll(dateStr, expiresAt) {
    // Build single prompt listing all regions
    const regionList = REGIONS_LIST.map(r => `- ${r}`).join('\n');
    const prompt = QUEST_PROMPT_TEMPLATE
        .replace(/\{\{regions\}\}/g, regionList)
        .replace(/\{\{date\}\}/g, dateStr)
        .replace(/\{\{count\}\}/g, String(COUNT));

    const { content: text, actualModel } = await genWithRetry(prompt);
    let regionMap;
    try {
        const parsed = JSON.parse(text);
        regionMap = parsed?.regions ?? parsed;
    } catch {
        throw new Error(`parse failed, response: ${text.slice(0, 300)}`);
    }

    if (!regionMap || typeof regionMap !== 'object') {
        throw new Error(`unexpected structure: ${text.slice(0, 200)}`);
    }

    const allQuests = [];
    for (const region of REGIONS_LIST) {
        // Try exact match first, then case-insensitive
        const arr = regionMap[region]
            ?? Object.entries(regionMap).find(([k]) => k.toLowerCase() === region.toLowerCase())?.[1]
            ?? [];

        if (!Array.isArray(arr) || !arr.length) {
            process.stderr.write(`  [warn] no quests returned for region: ${region}\n`);
            continue;
        }

        const quests = arr.slice(0, COUNT + 2).map((q, i) => ({
            id: `quest_${dateStr}_${region.replace(/\s+/g, '_')}_${i}`,
            title: String(q.title ?? ''),
            description: String(q.description ?? ''),
            hint: String(q.hint ?? q.description ?? ''),
            category: String(q.category ?? 'object'),
            difficulty: String(q.difficulty ?? 'common'),
            targetLabels: Array.isArray(q.targetLabels) ? q.targetLabels.map(String) : [],
            basePoints: BASE_POINTS[q.difficulty] ?? 100,
            rarityMultiplier: Number(q.rarityMultiplier ?? 1),
            region,
            expiresAt: Timestamp.fromDate(expiresAt),
            createdAt: Timestamp.now(),
            generatedBy: actualModel,
            isSeasonalEvent: Boolean(q.isSeasonalEvent),
            eventName: q.eventName ?? null,
            eventBadge: q.eventBadge ?? null,
            eventMultiplier: q.eventMultiplier ?? null,
        }));
        allQuests.push(...quests);
        process.stdout.write(`  ok: ${quests.length} quests for ${region}\n`);
    }

    return allQuests;
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

    process.stdout.write(`generating all ${REGIONS_LIST.length} regions in 1 request...\n`);
    const allQuests = await genAll(dateStr, tomorrow);

    if (!allQuests.length) {
        process.stderr.write('fatal: no quests generated\n');
        process.exit(1);
    }

    // Write to Firestore in batches of 500 (Firestore limit)
    const BATCH_SIZE = 500;
    for (let i = 0; i < allQuests.length; i += BATCH_SIZE) {
        const batch = db.batch();
        allQuests.slice(i, i + BATCH_SIZE).forEach(q => batch.set(db.collection('quests').doc(q.id), q));
        await batch.commit();
    }

    process.stdout.write(`done: ${allQuests.length} quests written across ${REGIONS_LIST.length} regions\n`);
}

main().catch(e => {
    process.stderr.write(`fatal: ${e.message}\n${e.stack}\n`);
    process.exit(1);
});
