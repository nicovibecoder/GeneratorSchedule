import { GoogleGenerativeAI } from '@google/generative-ai';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const required = ['GEMINI_API_KEY','FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','REGIONS','QUEST_PROMPT_TEMPLATE'];
const missing = required.filter(v => !process.env[v]);
if (missing.length) { process.stderr.write(`missing: ${missing.join(',')}\n`); process.exit(1); }

const {
    GEMINI_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY, REGIONS, QUEST_PROMPT_TEMPLATE,
    GEMINI_MODEL = 'gemini-2.0-flash-lite',
    QUESTS_PER_REGION = '5',
} = process.env;

const REGIONS_LIST = REGIONS.split(',').map(r => r.trim());
const COUNT = parseInt(QUESTS_PER_REGION, 10);
const BASE_POINTS = { common:100, uncommon:200, rare:400, epic:700, legendary:1200 };

initializeApp({ credential: cert({ projectId: FIREBASE_PROJECT_ID, clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g,'\n') }) });
const db = getFirestore();

const model = new GoogleGenerativeAI(GEMINI_API_KEY).getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { responseMimeType: 'application/json' },
});

async function gen(region, dateStr, expiresAt) {
    const prompt = QUEST_PROMPT_TEMPLATE.replace(/\{\{region\}\}/g, region).replace(/\{\{date\}\}/g, dateStr).replace(/\{\{count\}\}/g, String(COUNT));
    const text = (await model.generateContent(prompt)).response.text();
    let arr;
    try { arr = JSON.parse(text); } catch { const m = text.match(/\[[\s\S]*\]/); if (!m) throw new Error('parse'); arr = JSON.parse(m[0]); }
    if (!Array.isArray(arr) || !arr.length) throw new Error('empty');
    return arr.slice(0, COUNT + 2).map((q, i) => ({
        id: `quest_${dateStr}_${region.replace(/\s+/g,'_')}_${i}`,
        title: String(q.title ?? ''), description: String(q.description ?? ''),
        hint: String(q.hint ?? q.description ?? ''), category: String(q.category ?? 'object'),
        difficulty: String(q.difficulty ?? 'common'),
        targetLabels: JSON.stringify(Array.isArray(q.targetLabels) ? q.targetLabels : []),
        basePoints: BASE_POINTS[q.difficulty] ?? 100, rarityMultiplier: Number(q.rarityMultiplier ?? 1),
        region, expiresAt: Timestamp.fromDate(expiresAt), createdAt: Timestamp.now(),
        generatedBy: 'ai', isSeasonalEvent: Boolean(q.isSeasonalEvent),
        eventName: q.eventName ?? null, eventBadge: q.eventBadge ?? null, eventMultiplier: q.eventMultiplier ?? null,
    }));
}

async function cleanup() {
    const snap = await db.collection('quests').where('expiresAt','<',Timestamp.now()).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
}

async function main() {
    const dateStr = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate()+1); tomorrow.setUTCHours(0,0,0,0);

    await cleanup();

    const errors = [];
    for (const region of REGIONS_LIST) {
        try {
            const quests = await gen(region, dateStr, tomorrow);
            const batch = db.batch();
            quests.forEach(q => batch.set(db.collection('quests').doc(q.id), q));
            await batch.commit();
            if (region !== REGIONS_LIST.at(-1)) await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            errors.push(region);
        }
    }

    if (errors.length) { process.stderr.write(`failed: ${errors.join(',')}\n`); process.exit(1); }
}

main().catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
