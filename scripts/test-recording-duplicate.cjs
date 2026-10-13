const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => {
    const source = process.env.TEST_BASELINE === '1' && filename.endsWith('/model/db/ProgramDB.ts')
        ? require('node:child_process').execFileSync('git', ['show', 'HEAD:src/model/db/ProgramDB.ts'], { encoding: 'utf8' })
        : fs.readFileSync(filename, 'utf8');
    module._compile(ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
        experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
    }}).outputText, filename);
};
const Policy = require('../src/model/operator/RecordingDuplicatePolicy.ts').default;
const now = Date.now();
const day = 86400000;
const history = { name: '[新]作品', description: '第１話「始まり」', channelId: 400211, endAt: now - day };
const program = { name: '[再]作品', description: '第1話', channelId: 400211, startAt: now + day, endAt: now + day + 1800000 };

for (const [label, current, previous, duplicate] of [
    ['same numbered episode with repeat flag', {}, {}, true],
    ['new episode without repeat flag', { name: '作品', description: '第２話' }, {}, false],
    ['same episode without repeat flag', { name: '作品' }, {}, false],
    ['unrecorded episode even with repeat flag', { description: '第２話' }, {}, false],
    ['unicode repeat flag', { name: '🈞作品' }, {}, true],
    ['full-width brackets', { name: '［再］作品' }, {}, true],
    ['explicit rebroadcast flag', { name: '[再放送]作品' }, {}, true],
    ['different channel', { channelId: 400141 }, {}, false],
    ['different work', { name: '[再]別作品' }, {}, false],
    ['no current episode', { description: null }, {}, false],
    ['old title-only history lacks episode', {}, { description: null }, false],
    ['synopsis mentions another episode', { description: '前回は第1話。今回は冒険します' }, {}, false],
    ['title and synopsis disagree', { name: '[再]作品 #02' }, {}, false],
    ['hash episode and chapter normalize full-width', { name: '[再]作品 ＃０２', description: null }, { name: '作品', description: 'Chapter.２「少女」' }, true],
    ['episode in brackets remains evidence', { name: '[再]作品 [#01]', description: null }, {}, true],
    ['numbered old history after recording deletion', { name: '[再]作品 第1話', description: null }, { name: '作品 #01', description: null }, true],
    ['English episode', { description: 'Episode 01' }, {}, true],
    ['no guessed episode from title numbers', { name: '[再]作品 1', description: null }, { name: '作品 1', description: null }, false],
    ['future history is not recorded evidence', {}, { endAt: now + day }, false],
    ['history cannot belong to a later airing', { startAt: now - 2 * day }, {}, false],
    ['omnibus title', { name: '[再]作品 #1～2', description: null }, {}, false],
    ['omnibus description', { description: '第1話～第2話' }, {}, false],
    ['multiple title episodes', { name: '[再]作品 第1話 第2話', description: null }, {}, false],
    ['fractional special episode', { description: 'Chapter.1.5' }, {}, false],
    ['unknown bracketed work title is preserved', { name: '[再][別作品]' }, { name: '[作品]' }, false],
    ['new season is a different work', { name: '[再]作品 Season2' }, {}, false],
]) {
    test(label, () => assert.equal(Policy.isDuplicate({ ...program, ...current }, { ...history, ...previous }, undefined, now), duplicate));
}
test('duplicate period applies to both past history and future airing', () => {
    assert.equal(Policy.isDuplicate(program, history, 7, now), true);
    assert.equal(Policy.isDuplicate(program, { ...history, endAt: now - 8 * day }, 7, now), false);
    assert.equal(Policy.isDuplicate({ ...program, endAt: now + 8 * day }, history, 7, now), false);
});

const examples = [
    { ruleId: 265, id: 40014114102, channelId: 400141,
        name: 'アニメ　凶乱令嬢ニア・リストン 病弱令嬢に転生した神殺しの武人の華麗なる無双録',
        description: '第2話 王都での仕事', oldName: '[新]アニメ　凶乱令嬢ニア・リストン 病弱令嬢に転生した神殺しの武人の華麗なる無双録', oldDescription: '第1話 闇より浮かびて' },
    { ruleId: 269, id: 40021135239, channelId: 400211, name: '世界最強の魔女、始めました', description: '第２話',
        oldName: '[新]世界最強の魔女、始めました', oldDescription: '第１話『インターネットを使ってみた！』' },
    { ruleId: 255, id: 40021135384, channelId: 400211,
        name: '目覚めたら最強装備と宇宙船持ちだったので一戸建て目指して傭兵として自由に生きたい',
        description: 'Chapter.３「エルマ」', oldName: '目覚めたら最強装備と宇宙船持ちだったので一戸建て目指して傭兵として自由に生きたい',
        oldDescription: 'Chapter.２「少女・ミミ」' },
];

async function application(t, inputs) {
    const { DataSource } = require('typeorm');
    const entityDir = path.join(__dirname, '../src/db/entities');
    const entities = fs.readdirSync(entityDir).filter(name => name.endsWith('.ts')).map(name => require(path.join(entityDir, name)).default);
    const db = new DataSource({ type: 'sqlite', database: ':memory:', entities, synchronize: true });
    await db.initialize();
    t.after(async () => { if (db.isInitialized) await db.destroy(); });
    const logger = { getLogger: () => ({ system: { info() {}, debug() {}, warn() {}, error(...args) { console.error(...args); } } }) };
    const config = { getConfig: () => ({ dbtype: 'sqlite', needToReplaceEnclosingCharacters: true }) };
    const op = new (require('../src/model/db/DBOperator.ts').default)(logger, config);
    op.getConnection = async () => db;
    const retry = { run: work => work() };
    const programDB = new (require('../src/model/db/ProgramDB.ts').default)(logger, config, op, retry);
    const reserveDB = new (require('../src/model/db/ReserveDB.ts').default)(op, retry);
    const ruleDB = new (require('../src/model/db/RuleDB.ts').default)(op, retry);
    const Program = require('../src/db/entities/Program.ts').default;
    const Recorded = require('../src/db/entities/Recorded.ts').default;
    const History = require('../src/db/entities/RecordedHistory.ts').default;
    const StrUtil = require('../src/util/StrUtil.ts').default;
    const Rule = require('../src/db/entities/Rule.ts').default;
    // Existing schemas only. Fill required fields; leave historical nullable metadata absent.
    const save = async (Entity, values) => {
        const item = db.getRepository(Entity).create();
        for (const column of db.getMetadata(Entity).columns) {
            if (column.isGenerated || column.isNullable || column.default !== undefined || item[column.propertyName] !== undefined) continue;
            item[column.propertyName] = column.type === 'text' || column.type === String ? '' : column.type === Boolean ? false : 0;
        }
        return db.getRepository(Entity).save(Object.assign(item, values));
    };
    for (const [index, input] of inputs.entries()) {
        const startAt = now + (index + 1) * day;
        const endAt = startAt + 1800000;
        await save(Program, { id: input.id, channelId: input.channelId, channelType: 'BS', channel: String(input.channelId),
            name: input.name, halfWidthName: StrUtil.toHalf(input.name), shortName: StrUtil.deleteBrackets(StrUtil.toHalf(input.name)),
            description: input.description, halfWidthDescription: StrUtil.toHalf(input.description), startAt, endAt, duration: 1800000 });
        await save(Recorded, { channelId: input.channelId, name: input.oldName, halfWidthName: StrUtil.toHalf(input.oldName),
            description: input.oldDescription, endAt: now - day, isRecording: false });
        await save(History, { channelId: input.channelId, name: StrUtil.deleteBrackets(StrUtil.toHalf(input.oldName)), endAt: now - day });
        await save(Rule, ruleDB.convertRuleToDBRule({ id: input.ruleId, isTimeSpecification: false,
            searchOption: { keyword: StrUtil.deleteBrackets(input.name), name: true, channelIds: [input.channelId] },
            reserveOption: { enable: true, avoidDuplicate: true, allowEndLack: true, removeDataBroadcast: true },
            saveOption: { directory: '2026-10/test' } }));
    }
    const execution = new (require('../src/model/ExecutionManagementModel.ts').default)(logger);
    const reservation = new (require('../src/model/operator/reservation/ReservationManageModel.ts').default)(
        logger, config, execution, {}, reserveDB, {}, programDB, ruleDB, { emitUpdated() {} });
    reservation.setTuners([{ types: ['BS'] }, { types: ['BS'] }]);
    const ipc = { reserveation: {
        updateAll: async () => { for (const input of inputs) await reservation.updateRule(input.ruleId); },
        removeOverlap: id => reservation.removeOverlap(id),
    } };
    const api = new (require('../src/model/api/reserve/ReserveApiModel.ts').default)(ipc, reserveDB);
    const container = require('../src/model/ModelContainer.ts').default;
    container.bind('IReserveApiModel').toConstantValue(api);
    container.bind('IScheduleApiModel').toConstantValue(new (require('../src/model/api/schedule/ScheduleApiModel.ts').default)({}, programDB));
    t.after(() => container.unbindAll());
    const express = require('express');
    const app = express();
    app.use(express.json());
    // Actual application HTTP handlers, API models, SQL queries, and reservation writer.
    app.post('/api/reserves/update', require('../src/model/service/api/reserves/update.ts').post);
    app.get('/api/reserves', (req, res, next) => { req.query.isHalfWidth = req.query.isHalfWidth === 'true'; next(); }, require('../src/model/service/api/reserves.ts').get);
    app.delete('/api/reserves/:reserveId/overlap', require('../src/model/service/api/reserves/{reserveId}/overlap.ts').del);
    app.post('/api/schedules/search', require('../src/model/service/api/schedules/search.ts').post);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api`;
    const http = async (route, method = 'GET', body) => {
        const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        assert.equal(response.status, 200, `${method} ${route}: ${text}`);
        return text ? JSON.parse(text) : undefined;
    };
    return { db, programDB, ruleDB, reservation, http, Program, Recorded, History, save };
}

test('new episodes are preserved through reservation update and complete HTTP response', async t => {
    const { http } = await application(t, examples);
    assert.deepEqual(await http('/reserves/update', 'POST'), { code: 200 });
    const response = await http('/reserves?isHalfWidth=false&limit=100');
    assert.equal(response.total, 3);
    assert.deepEqual(response.reserves, examples.map((input, index) => ({
        id: index + 1, isSkip: false, isConflict: false, isOverlap: false,
        allowEndLack: true, removeDataBroadcast: true, isTimeSpecified: false, isDeleteOriginalAfterEncode: false,
        channelId: input.channelId, startAt: now + (index + 1) * day, endAt: now + (index + 1) * day + 1800000,
        name: input.name, ruleId: input.ruleId, directory: '2026-10/test', programId: input.id, description: input.description,
    })));
    assert.deepEqual(await http('/reserves?type=overlap&isHalfWidth=false'), { reserves: [], total: 0 });
    const search = await http('/schedules/search', 'POST', { isHalfWidth: false, option: { keyword: examples[1].name, name: true } });
    assert.deepEqual(search, [{ id: examples[1].id, channelId: examples[1].channelId, startAt: now + 2 * day,
        endAt: now + 2 * day + 1800000, isFree: false, name: examples[1].name, description: examples[1].description }]);
});

test('repeat evidence, opt-out, old metadata, period, and manual unlock flow through real SQL and HTTP', async t => {
    const input = { ...examples[1], name: '[再]' + examples[1].name, description: '第１話' };
    const { db, http, programDB, ruleDB, reservation, Program, Recorded, History } = await application(t, [input]);
    const query = { searchOption: { keyword: examples[1].name, name: true }, reserveOption: { avoidDuplicate: true } };
    assert.equal((await programDB.findRule(query))[0].overlap, true);
    assert.equal((await programDB.findRule({ ...query, reserveOption: { avoidDuplicate: false } }))[0].overlap, false);
    assert.equal((await programDB.findRule({ ...query, reserveOption: { avoidDuplicate: true, periodToAvoidDuplicate: 1 } }))[0].overlap, false);
    await http('/reserves/update', 'POST');
    const overlap = await http('/reserves?type=overlap&isHalfWidth=false');
    assert.equal(overlap.total, 1);
    assert.equal(overlap.reserves[0].isOverlap, true);
    const id = overlap.reserves[0].id;
    await http(`/reserves/${id}/overlap`, 'DELETE');
    await http('/reserves/update', 'POST');
    const unlocked = await http('/reserves?isHalfWidth=false');
    assert.equal(unlocked.reserves[0].id, id);
    assert.equal(unlocked.reserves[0].isOverlap, false);
    assert.equal(unlocked.reserves[0].isConflict, false);
    await db.getRepository(Program).update(input.id, { description: '第２話' });
    assert.equal((await programDB.findRule(query))[0].overlap, false);
    await db.getRepository(Program).update(input.id, { description: '第１話' });
    await db.getRepository(Recorded).delete({});
    assert.equal((await programDB.findRule(query))[0].overlap, false);
    // Previously marked overlap converges on the next normal rule update; no operator repair needed.
    await db.query('UPDATE reserve SET isOverlap = 1, isIgnoreOverlap = 0 WHERE id = ?', [id]);
    await reservation.updateRule(input.ruleId);
    assert.deepEqual(await http('/reserves?type=overlap&isHalfWidth=false'), { reserves: [], total: 0 });
    const rule = await ruleDB.findId(input.ruleId, true);
    assert.equal(rule.reserveOption.avoidDuplicate, true);
    // Deleted recordings still have useful episode evidence when it was in the historical title.
    await db.getRepository(History).update({ channelId: input.channelId }, { name: examples[1].name + ' #01' });
    await db.getRepository(Program).update(input.id, { name: '[再]' + examples[1].name + ' #01' });
    assert.equal((await programDB.findRule(query))[0].overlap, true);
    await db.getRepository(History).delete({});
    assert.equal((await programDB.findRule(query))[0].overlap, false);
});

test('read-only live production episode metadata replay', { skip: !process.env.EPGSTATION_ACCEPTANCE_URL }, async t => {
    const base = process.env.EPGSTATION_ACCEPTANCE_URL.replace(/\/$/, '') + '/api';
    const inputs = [];
    for (const fixture of examples) {
        const get = async route => {
            const response = await fetch(base + route);
            assert.equal(response.status, 200, route);
            return response.json();
        };
        const reserves = await get(`/reserves?ruleId=${fixture.ruleId}&isHalfWidth=false&limit=100`);
        const recordings = await get(`/recorded?ruleId=${fixture.ruleId}&isHalfWidth=false&limit=100`);
        const current = reserves.reserves.find(item => item.programId === fixture.id);
        assert.ok(current, `missing current episode ${fixture.id}`);
        const previous = recordings.records.find(item => item.description === fixture.oldDescription);
        assert.ok(previous, `missing recorded episode for rule ${fixture.ruleId}`);
        inputs.push({ ...fixture, name: current.name, description: current.description, oldName: previous.name, oldDescription: previous.description });
    }
    const { http } = await application(t, inputs);
    await http('/reserves/update', 'POST');
    assert.deepEqual(await http('/reserves?type=overlap&isHalfWidth=false'), { reserves: [], total: 0 });
    const result = await http('/reserves?isHalfWidth=false');
    assert.equal(result.total, 3);
    for (const reserve of result.reserves) {
        const expected = inputs.find(input => input.id === reserve.programId);
        assert.equal(reserve.name, expected.name);
        assert.equal(reserve.description, expected.description);
        assert.equal(reserve.ruleId, expected.ruleId);
        assert.equal(reserve.isOverlap, false);
        assert.equal(reserve.isConflict, false);
        assert.equal(reserve.isSkip, false);
    }
});
