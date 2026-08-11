import { timingSafeEqual } from 'node:crypto';

type Flash = {
  kind: 'error' | 'success';
  message: string;
};

type TagRow = {
  id: number;
  name: string;
  date_added: string;
};

type TuneRow = {
  id: number;
  title: string;
  notes: string;
  youtube_identifier: string;
  sheet_music_reference: string | null;
  submitted_ip: string;
  date_added: string;
  date_accepted: string | null;
};

type HomeTuneRow = TuneRow & {
  upvotes: number;
  downvotes: number;
  visitor_vote: number | null;
};

type HomeTune = HomeTuneRow & {
  tags: TagRow[];
};

type AdminTune = TuneRow & {
  upvotes: number;
  downvotes: number;
  tags: TagRow[];
};

type SubmissionDraft = {
  title: string;
  notes: string;
  youtubeInput: string;
  sheetMusicReference: string;
  tagIds: number[];
  returnTuneId: number | null;
};

type ValidTuneInput = {
  title: string;
  notes: string;
  youtubeIdentifier: string;
  sheetMusicReference: string | null;
  tagIds: number[];
};

const AUTH_REALM = 'jams.dk moderators';
const MAX_TITLE_LENGTH = 120;
const MAX_NOTES_LENGTH = 4000;
const MAX_TAG_LENGTH = 40;
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const textEncoder = new TextEncoder();

const HOME_TUNE_SELECT = `
  SELECT
    t.id,
    t.title,
    t.notes,
    t.youtube_identifier,
    t.sheet_music_reference,
    t.submitted_ip,
    t.date_added,
    t.date_accepted,
    COALESCE((SELECT COUNT(*) FROM votes v WHERE v.tune_id = t.id AND v.value = 1), 0) AS upvotes,
    COALESCE((SELECT COUNT(*) FROM votes v WHERE v.tune_id = t.id AND v.value = -1), 0) AS downvotes,
    (SELECT value FROM votes v WHERE v.tune_id = t.id AND v.visitor_ip = ? LIMIT 1) AS visitor_vote
  FROM tunes t
`;

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (isModeratorPath(url.pathname)) {
        if (!checkBasicAuth(request, env)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'www-authenticate': `Basic realm="${AUTH_REALM}"`,
            },
          });
        }

        return handleModeratorRequest(request, env, url);
      }

      if (request.method === 'GET' && url.pathname === '/') {
        return renderHomePage(request, env, url);
      }

      if (request.method === 'POST' && url.pathname === '/submit') {
        return handleTuneSubmission(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/vote') {
        return handleVote(request, env, url);
      }

      return textResponse('Not found', 404);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'request_error',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return textResponse('Internal Server Error', 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function renderHomePage(
  request: Request,
  env: Env,
  url: URL,
  options: {
    flash?: Flash;
    draft?: SubmissionDraft;
    submissionOpen?: boolean;
    currentTuneId?: number | null;
  } = {},
): Promise<Response> {
  const currentTuneId = options.currentTuneId ?? parsePositiveInt(url.searchParams.get('tune'));
  const visitorIp = getVisitorIp(request);
  const [tags, tune] = await Promise.all([
    listTags(env.DB),
    getAcceptedTune(env.DB, currentTuneId, visitorIp),
  ]);

  const flash = options.flash ?? getHomeFlash(url);
  const draft = options.draft ?? emptySubmissionDraft(tune?.id ?? currentTuneId ?? null);

  return htmlResponse(
    renderHomeHtml({
      flash,
      tune,
      tags,
      draft,
      submissionOpen: options.submissionOpen ?? false,
    }),
  );
}

async function handleTuneSubmission(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const draft = submissionDraftFromForm(formData);
  const validated = validateTuneInput({
    title: draft.title,
    notes: draft.notes,
    youtubeInput: draft.youtubeInput,
    sheetMusicReference: draft.sheetMusicReference,
    tagIds: draft.tagIds,
  });

  if (!validated.ok) {
    if (isHtmxRequest(request)) {
      return htmlResponse(
        renderSubmissionPanel(await listTags(env.DB), draft, { kind: 'error', message: validated.message }),
      );
    }

    return renderHomePage(request, env, new URL(request.url), {
      flash: { kind: 'error', message: validated.message },
      draft,
      submissionOpen: true,
      currentTuneId: draft.returnTuneId,
    });
  }

  const tagIds = await filterExistingTagIds(env.DB, validated.value.tagIds);
  const submittedIp = getVisitorIp(request);
  const insert = await env.DB
    .prepare(
      `INSERT INTO tunes (title, notes, youtube_identifier, sheet_music_reference, submitted_ip)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      validated.value.title,
      validated.value.notes,
      validated.value.youtubeIdentifier,
      validated.value.sheetMusicReference,
      submittedIp,
    )
    .run();

  await syncTuneTags(env.DB, insert.meta.last_row_id, tagIds);

  if (isHtmxRequest(request)) {
    return htmlResponse(
      renderSubmissionPanel(await listTags(env.DB), emptySubmissionDraft(draft.returnTuneId), {
        kind: 'success',
        message: 'Thanks — your tune is waiting for a moderator.',
      }),
    );
  }

  return redirectTo(request.url, '/?flash=submitted');
}

async function handleVote(request: Request, env: Env, url: URL): Promise<Response> {
  const formData = await request.formData();
  const tuneId = parsePositiveInt(formData.get('tune_id'));
  const value = Number.parseInt(String(formData.get('value') ?? ''), 10);

  if (!tuneId || ![-1, 1].includes(value)) {
    return isHtmxRequest(request)
      ? htmlResponse(renderVoteBoxError('That tune is gone. Reload for another one.'))
      : redirectTo(url.toString(), '/?flash=missing-tune');
  }

  const tune = await env.DB
    .prepare('SELECT id FROM tunes WHERE id = ? AND date_accepted IS NOT NULL LIMIT 1')
    .bind(tuneId)
    .first<{ id: number }>();

  if (!tune) {
    return isHtmxRequest(request)
      ? htmlResponse(renderVoteBoxError('That tune is gone. Reload for another one.'))
      : redirectTo(url.toString(), '/?flash=missing-tune');
  }

  const visitorIp = getVisitorIp(request);
  await env.DB
    .prepare(
      `INSERT INTO votes (tune_id, visitor_ip, value)
       VALUES (?, ?, ?)
       ON CONFLICT(tune_id, visitor_ip)
       DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(tuneId, visitorIp, value)
    .run();

  if (isHtmxRequest(request)) {
    const updatedTune = await getAcceptedTune(env.DB, tuneId, visitorIp);
    return htmlResponse(
      updatedTune ? renderVoteBox(updatedTune) : renderVoteBoxError('That tune is gone. Reload for another one.'),
    );
  }

  return redirectTo(url.toString(), `/?tune=${tuneId}&flash=voted#vote`);
}

async function handleModeratorRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'GET' && url.pathname === '/kustode') {
    return renderModeratorDashboard(env, getModeratorFlash(url));
  }

  if (request.method === 'POST' && url.pathname === '/kustode/tags') {
    return handleModeratorTagCreate(request, env);
  }

  const tuneMatch = url.pathname.match(/^\/kustode\/tunes\/(\d+)\/(save|accept|pending|delete)$/);
  if (request.method === 'POST' && tuneMatch) {
    return handleModeratorTuneAction(request, env, Number(tuneMatch[1]), tuneMatch[2]);
  }

  return textResponse('Not found', 404);
}

async function renderModeratorDashboard(env: Env, flash?: Flash): Promise<Response> {
  const [tags, tunes] = await Promise.all([listTags(env.DB), listTunesForModerator(env.DB)]);
  return htmlResponse(renderModeratorHtml({ flash, tags, tunes }));
}

async function handleModeratorTagCreate(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const rawName = String(formData.get('name') ?? '').trim().replace(/\s+/g, ' ');
  const name = rawName.toLowerCase();

  if (!name) {
    return renderModeratorDashboard(env, { kind: 'error', message: 'Tag name is required.' });
  }

  if (name.length > MAX_TAG_LENGTH) {
    return renderModeratorDashboard(env, {
      kind: 'error',
      message: `Keep tags under ${MAX_TAG_LENGTH} characters.`,
    });
  }

  const existing = await env.DB
    .prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE LIMIT 1')
    .bind(name)
    .first<{ id: number }>();

  if (existing) {
    return renderModeratorDashboard(env, { kind: 'error', message: 'That tag already exists.' });
  }

  await env.DB.prepare('INSERT INTO tags (name) VALUES (?)').bind(name).run();
  return redirectTo(request.url, '/kustode?flash=tag-created');
}

async function handleModeratorTuneAction(
  request: Request,
  env: Env,
  tuneId: number,
  action: 'save' | 'accept' | 'pending' | 'delete' | string,
): Promise<Response> {
  if (action === 'delete') {
    await deleteTune(env.DB, tuneId);
    return redirectTo(request.url, '/kustode?flash=deleted');
  }

  const formData = await request.formData();
  const validated = validateTuneInput({
    title: String(formData.get('title') ?? ''),
    notes: String(formData.get('notes') ?? ''),
    youtubeInput: String(formData.get('youtube_identifier') ?? ''),
    sheetMusicReference: String(formData.get('sheet_music_reference') ?? ''),
    tagIds: parseTagIds(formData),
  });

  if (!validated.ok) {
    return renderModeratorDashboard(env, { kind: 'error', message: validated.message });
  }

  const tagIds = await filterExistingTagIds(env.DB, validated.value.tagIds);

  let query = `
    UPDATE tunes
    SET title = ?, notes = ?, youtube_identifier = ?, sheet_music_reference = ?
    WHERE id = ?
  `;
  let flash = 'saved';

  if (action === 'accept') {
    query = `
      UPDATE tunes
      SET title = ?, notes = ?, youtube_identifier = ?, sheet_music_reference = ?,
          date_accepted = COALESCE(date_accepted, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = ?
    `;
    flash = 'accepted';
  }

  if (action === 'pending') {
    query = `
      UPDATE tunes
      SET title = ?, notes = ?, youtube_identifier = ?, sheet_music_reference = ?,
          date_accepted = NULL
      WHERE id = ?
    `;
    flash = 'pending';
  }

  const result = await env.DB
    .prepare(query)
    .bind(
      validated.value.title,
      validated.value.notes,
      validated.value.youtubeIdentifier,
      validated.value.sheetMusicReference,
      tuneId,
    )
    .run();

  if (result.meta.changes < 1) {
    return renderModeratorDashboard(env, { kind: 'error', message: 'Tune not found.' });
  }

  await syncTuneTags(env.DB, tuneId, tagIds);
  return redirectTo(request.url, `/kustode?flash=${flash}`);
}

async function getAcceptedTune(
  db: D1Database,
  requestedId: number | null,
  visitorIp: string,
): Promise<HomeTune | null> {
  if (requestedId) {
    const requested = await db
      .prepare(`${HOME_TUNE_SELECT} WHERE t.id = ? AND t.date_accepted IS NOT NULL LIMIT 1`)
      .bind(visitorIp, requestedId)
      .first<HomeTuneRow>();

    if (requested) {
      return withTags(db, requested);
    }
  }

  // ponytail: ORDER BY RANDOM() is fine for a small tune catalog; switch to sampling ids if the table gets big.
  const random = await db
    .prepare(`${HOME_TUNE_SELECT} WHERE t.date_accepted IS NOT NULL ORDER BY RANDOM() LIMIT 1`)
    .bind(visitorIp)
    .first<HomeTuneRow>();

  return random ? withTags(db, random) : null;
}

async function withTags<T extends { id: number }>(db: D1Database, tune: T): Promise<T & { tags: TagRow[] }> {
  const { results } = await db
    .prepare(
      `SELECT tg.id, tg.name, tg.date_added
       FROM tune_tags tt
       JOIN tags tg ON tg.id = tt.tag_id
       WHERE tt.tune_id = ?
       ORDER BY tg.name`,
    )
    .bind(tune.id)
    .all<TagRow>();

  return { ...tune, tags: results ?? [] };
}

async function listTags(db: D1Database): Promise<TagRow[]> {
  const { results } = await db
    .prepare('SELECT id, name, date_added FROM tags ORDER BY name')
    .all<TagRow>();

  return results ?? [];
}

async function listTunesForModerator(db: D1Database): Promise<AdminTune[]> {
  const { results } = await db
    .prepare(`
      SELECT
        t.id,
        t.title,
        t.notes,
        t.youtube_identifier,
        t.sheet_music_reference,
        t.submitted_ip,
        t.date_added,
        t.date_accepted,
        COALESCE((SELECT COUNT(*) FROM votes v WHERE v.tune_id = t.id AND v.value = 1), 0) AS upvotes,
        COALESCE((SELECT COUNT(*) FROM votes v WHERE v.tune_id = t.id AND v.value = -1), 0) AS downvotes
      FROM tunes t
      ORDER BY t.date_accepted IS NULL DESC, t.date_added DESC, t.id DESC
    `)
    .all<AdminTune>();

  const tunes = results ?? [];
  if (!tunes.length) return [];

  const tuneIds = tunes.map((tune) => tune.id);
  const placeholders = tuneIds.map(() => '?').join(', ');
  const { results: tagRows } = await db
    .prepare(
      `SELECT tt.tune_id, tg.id, tg.name, tg.date_added
       FROM tune_tags tt
       JOIN tags tg ON tg.id = tt.tag_id
       WHERE tt.tune_id IN (${placeholders})
       ORDER BY tg.name`,
    )
    .bind(...tuneIds)
    .all<TagRow & { tune_id: number }>();

  const tagsByTuneId = new Map<number, TagRow[]>();
  for (const row of tagRows ?? []) {
    const current = tagsByTuneId.get(row.tune_id) ?? [];
    current.push({ id: row.id, name: row.name, date_added: row.date_added });
    tagsByTuneId.set(row.tune_id, current);
  }

  return tunes.map((tune) => ({ ...tune, tags: tagsByTuneId.get(tune.id) ?? [] }));
}

async function syncTuneTags(db: D1Database, tuneId: number, rawTagIds: number[]): Promise<void> {
  const tagIds = await filterExistingTagIds(db, rawTagIds);
  const statements = [db.prepare('DELETE FROM tune_tags WHERE tune_id = ?').bind(tuneId)];

  for (const tagId of tagIds) {
    statements.push(db.prepare('INSERT INTO tune_tags (tune_id, tag_id) VALUES (?, ?)').bind(tuneId, tagId));
  }

  await db.batch(statements);
}

async function filterExistingTagIds(db: D1Database, rawTagIds: number[]): Promise<number[]> {
  const tagIds = [...new Set(rawTagIds)].filter((tagId) => Number.isInteger(tagId) && tagId > 0);
  if (!tagIds.length) return [];

  const placeholders = tagIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT id FROM tags WHERE id IN (${placeholders}) ORDER BY id`)
    .bind(...tagIds)
    .all<{ id: number }>();

  return (results ?? []).map((row) => row.id);
}

async function deleteTune(db: D1Database, tuneId: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM tune_tags WHERE tune_id = ?').bind(tuneId),
    db.prepare('DELETE FROM votes WHERE tune_id = ?').bind(tuneId),
    db.prepare('DELETE FROM tunes WHERE id = ?').bind(tuneId),
  ]);
}

function submissionDraftFromForm(formData: FormData): SubmissionDraft {
  return {
    title: String(formData.get('title') ?? '').trim(),
    notes: String(formData.get('notes') ?? '').trim(),
    youtubeInput: String(formData.get('youtube_identifier') ?? '').trim(),
    sheetMusicReference: String(formData.get('sheet_music_reference') ?? '').trim(),
    tagIds: parseTagIds(formData),
    returnTuneId: parsePositiveInt(formData.get('return_tune_id')),
  };
}

function validateTuneInput(input: {
  title: string;
  notes: string;
  youtubeInput: string;
  sheetMusicReference: string;
  tagIds: number[];
}): { ok: true; value: ValidTuneInput } | { ok: false; message: string } {
  const title = input.title.trim();
  if (!title) {
    return { ok: false, message: 'Title is required.' };
  }

  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, message: `Keep titles under ${MAX_TITLE_LENGTH} characters.` };
  }

  const notes = input.notes.trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    return { ok: false, message: `Keep notes under ${MAX_NOTES_LENGTH} characters.` };
  }

  const youtubeIdentifier = normalizeYouTubeIdentifier(input.youtubeInput);
  if (!youtubeIdentifier) {
    return { ok: false, message: 'Add a valid YouTube video ID or URL.' };
  }

  const sheetMusicReference = normalizeHttpUrl(input.sheetMusicReference);
  if (input.sheetMusicReference.trim() && !sheetMusicReference) {
    return { ok: false, message: 'Sheet music must be a full http or https URL.' };
  }

  return {
    ok: true,
    value: {
      title,
      notes,
      youtubeIdentifier,
      sheetMusicReference,
      tagIds: [...new Set(input.tagIds)],
    },
  };
}

function emptySubmissionDraft(returnTuneId: number | null): SubmissionDraft {
  return {
    title: '',
    notes: '',
    youtubeInput: '',
    sheetMusicReference: '',
    tagIds: [],
    returnTuneId,
  };
}

function getHomeFlash(url: URL): Flash | undefined {
  switch (url.searchParams.get('flash')) {
    case 'submitted':
      return { kind: 'success', message: 'Thanks — your tune is waiting for a moderator.' };
    case 'voted':
      return { kind: 'success', message: 'Vote saved.' };
    case 'missing-tune':
      return { kind: 'error', message: 'That tune is gone, so here is another one.' };
    default:
      return undefined;
  }
}

function getModeratorFlash(url: URL): Flash | undefined {
  switch (url.searchParams.get('flash')) {
    case 'tag-created':
      return { kind: 'success', message: 'Tag created.' };
    case 'saved':
      return { kind: 'success', message: 'Tune saved.' };
    case 'accepted':
      return { kind: 'success', message: 'Tune accepted and now appears on the front page.' };
    case 'pending':
      return { kind: 'success', message: 'Tune moved back to the pending pile.' };
    case 'deleted':
      return { kind: 'success', message: 'Tune deleted.' };
    default:
      return undefined;
  }
}

function isModeratorPath(pathname: string): boolean {
  return pathname === '/kustode' || pathname.startsWith('/kustode/');
}

function isHtmxRequest(request: Request): boolean {
  return request.headers.get('hx-request') === 'true';
}

export function checkBasicAuth(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Basic ')) return false;

  let decoded = '';
  try {
    decoded = atob(authHeader.slice(6));
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex < 0) return false;

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return safeEqual(username, env.BASIC_AUTH_USER) && safeEqual(password, env.BASIC_AUTH_PASSWORD);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function getVisitorIp(request: Request): string {
  const forwarded = request.headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((value) => value.trim())
    .find(Boolean);

  return request.headers.get('cf-connecting-ip') ?? forwarded ?? '127.0.0.1';
}

function parseTagIds(formData: FormData): number[] {
  return [...new Set(formData.getAll('tag_ids').map((value) => Number.parseInt(String(value), 10)).filter(isPositiveInteger))];
}

function parsePositiveInt(value: unknown): number | null {
  const number = Number.parseInt(String(value ?? ''), 10);
  return isPositiveInteger(number) ? number : null;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function normalizeYouTubeIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (YOUTUBE_ID_PATTERN.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  let candidate = '';

  if (hostname === 'youtu.be') {
    candidate = url.pathname.split('/').filter(Boolean)[0] ?? '';
  } else if (hostname.endsWith('youtube.com') || hostname.endsWith('youtube-nocookie.com')) {
    candidate =
      url.searchParams.get('v') ??
      url.pathname.split('/').filter(Boolean).find((part, index, parts) => ['embed', 'shorts', 'live'].includes(parts[index - 1] ?? '')) ??
      '';
  }

  return YOUTUBE_ID_PATTERN.test(candidate) ? candidate : null;
}

function normalizeHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function redirectTo(baseUrl: string, path: string): Response {
  return Response.redirect(new URL(path, baseUrl).toString(), 303);
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function renderVoteBox(tune: HomeTune): string {
  return `
    <section id="vote" class="vote-box" aria-label="Vote on this tune">
      <div class="vote-buttons">
        <form method="post" action="/vote" hx-post="/vote" hx-target="#vote" hx-swap="outerHTML">
          <input type="hidden" name="tune_id" value="${tune.id}">
          <input type="hidden" name="value" value="1">
          <button class="vote ${tune.visitor_vote === 1 ? 'active up' : ''}" type="submit" aria-label="Thumbs up">👍 ${tune.upvotes}</button>
        </form>
        <form method="post" action="/vote" hx-post="/vote" hx-target="#vote" hx-swap="outerHTML">
          <input type="hidden" name="tune_id" value="${tune.id}">
          <input type="hidden" name="value" value="-1">
          <button class="vote ${tune.visitor_vote === -1 ? 'active down' : ''}" type="submit" aria-label="Thumbs down">👎 ${tune.downvotes}</button>
        </form>
        <a class="icon-button" href="/" aria-label="Another tune" title="Another tune">↻</a>
      </div>
    </section>
  `;
}

function renderVoteBoxError(message: string): string {
  return `
    <section id="vote" class="vote-box" aria-label="Vote on this tune">
      <p class="vote-error">${escapeHtml(message)}</p>
      <div class="vote-buttons">
        <a class="icon-button" href="/" aria-label="Another tune" title="Another tune">↻</a>
      </div>
    </section>
  `;
}

function renderSheetMusicPanel(tune: HomeTune): string {
  if (!tune.sheet_music_reference) return '';

  return `
    <aside class="sheet-panel">
      <a
        class="sheet-link"
        href="${escapeHtml(tune.sheet_music_reference)}"
        target="_blank"
        rel="noopener noreferrer nofollow"
        aria-label="Open sheet music"
        title="Open sheet music"
      >↗</a>
      <iframe
        class="sheet-frame"
        src="${escapeHtml(tune.sheet_music_reference)}"
        title="Sheet music for ${escapeHtml(tune.title)}"
        loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"
      ></iframe>
    </aside>
  `;
}

function renderSubmissionPanel(tags: TagRow[], draft: SubmissionDraft, flash?: Flash): string {
  const selectedTagIds = new Set(draft.tagIds);

  return `
    <div id="submit-panel" class="modal-card">
      <div class="modal-head">
        <div>
          <h2 id="submit-title">Submit a tune</h2>
          <p class="help">Submissions land in the moderator queue at <code>/kustode</code>.</p>
        </div>
        <form method="dialog">
          <button class="close" type="submit" aria-label="Close">×</button>
        </form>
      </div>
      ${flash ? `<p class="flash ${flash.kind}">${escapeHtml(flash.message)}</p>` : ''}
      <form method="post" action="/submit" hx-post="/submit" hx-target="#submit-panel" hx-swap="outerHTML">
        <input type="hidden" name="return_tune_id" value="${draft.returnTuneId ?? ''}">
        <label class="field">
          <span>Title</span>
          <input name="title" maxlength="${MAX_TITLE_LENGTH}" value="${escapeHtml(draft.title)}" required>
        </label>
        <label class="field">
          <span>YouTube URL or video ID</span>
          <input name="youtube_identifier" value="${escapeHtml(draft.youtubeInput)}" required>
        </label>
        <label class="field">
          <span>Sheet music link</span>
          <input name="sheet_music_reference" type="url" value="${escapeHtml(draft.sheetMusicReference)}" placeholder="https://thesession.org/...">
        </label>
        <label class="field">
          <span>Notes</span>
          <textarea name="notes" maxlength="${MAX_NOTES_LENGTH}" placeholder="Key, tuning, favourite recording, whatever helps.">${escapeHtml(draft.notes)}</textarea>
        </label>
        <div class="field">
          <span>Tags</span>
          ${
            tags.length
              ? `<div class="tag-grid">${tags
                  .map(
                    (tag) => `<label class="tag-choice"><input type="checkbox" name="tag_ids" value="${tag.id}" ${selectedTagIds.has(tag.id) ? 'checked' : ''}> <span>${escapeHtml(tag.name)}</span></label>`,
                  )
                  .join('')}</div>`
              : '<p class="help">No tags yet. Submit anyway and a moderator can tidy it up.</p>'
          }
        </div>
        <div class="modal-actions">
          <button class="primary" type="submit">Send for review</button>
        </div>
      </form>
    </div>
  `;
}

function renderHomeHtml({
  flash,
  tune,
  tags,
  draft,
  submissionOpen,
}: {
  flash?: Flash;
  tune: HomeTune | null;
  tags: TagRow[];
  draft: SubmissionDraft;
  submissionOpen: boolean;
}): string {
  const dialogOpen = submissionOpen ? ' open' : '';
  const tuneSection = tune
    ? `
      <section class="tune-stage ${tune.sheet_music_reference ? 'has-sheet' : 'solo'}">
        <article class="tune-main">
          <div class="video-frame">
            <iframe
              src="https://www.youtube.com/embed/${escapeHtml(tune.youtube_identifier)}"
              title="${escapeHtml(tune.title)} on YouTube"
              loading="lazy"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowfullscreen
              referrerpolicy="strict-origin-when-cross-origin"
            ></iframe>
          </div>
          <div class="tune-meta">
            <h1>${escapeHtml(tune.title)}</h1>
            ${renderTagBadges(tune.tags)}
            ${tune.notes ? `<p class="notes">${escapeHtml(tune.notes).replaceAll('\n', '<br>')}</p>` : ''}
            ${renderVoteBox(tune)}
          </div>
        </article>
        ${renderSheetMusicPanel(tune)}
      </section>
    `
    : `
      <article class="empty-state">
        <h1>No accepted tune yet.</h1>
        <p>Hit + and submit the first one.</p>
      </article>
    `;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>jams.dk</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3ead8;
        --panel: rgba(255, 250, 241, 0.88);
        --panel-solid: #fffaf1;
        --ink: #221810;
        --muted: #6f5b4c;
        --line: rgba(95, 66, 45, 0.14);
        --accent: #a53a1b;
        --accent-ink: #fff8f2;
        --good: #1c6b32;
        --bad: #8f2d2d;
        --shadow: 0 1.25rem 3rem rgba(34, 24, 16, 0.10);
      }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        font: 16px/1.5 system-ui, sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top, rgba(255,255,255,0.45), transparent 40%),
          linear-gradient(180deg, #f8efdf 0%, var(--bg) 100%);
      }
      a { color: inherit; }
      button, input, textarea { font: inherit; }
      .shell {
        max-width: 92rem;
        margin: 0 auto;
        padding: 1rem 1rem 6rem;
      }
      .flash {
        margin: 0 0 1rem;
        padding: 0.9rem 1rem;
        border-radius: 1rem;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.8);
        backdrop-filter: blur(12px);
      }
      .flash.error { border-color: #d7aaaa; color: #6f2020; }
      .flash.success { border-color: #b4c9b6; color: #194d25; }
      .tune-stage {
        display: grid;
        gap: 1rem;
        align-items: start;
      }
      .tune-stage.has-sheet {
        grid-template-columns: minmax(0, 1.7fr) minmax(18rem, 0.9fr);
      }
      .tune-main,
      .sheet-panel,
      .empty-state {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 1.6rem;
        box-shadow: var(--shadow);
        backdrop-filter: blur(12px);
      }
      .tune-main {
        overflow: hidden;
      }
      .video-frame {
        aspect-ratio: 16 / 9;
        background: #000;
      }
      .video-frame iframe,
      .sheet-frame {
        width: 100%;
        height: 100%;
        border: 0;
      }
      .tune-meta {
        padding: 1rem 1rem 1.15rem;
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 4vw, 3.5rem);
        line-height: 0.98;
        text-wrap: balance;
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        list-style: none;
        padding: 0;
        margin: 0.85rem 0 0;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 0.3rem 0.7rem;
        background: rgba(255,255,255,0.82);
        color: var(--muted);
        font-size: 0.9rem;
      }
      .notes {
        margin: 0.85rem 0 0;
        color: var(--muted);
      }
      .vote-box {
        margin-top: 1rem;
      }
      .vote-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        align-items: center;
      }
      .vote, .icon-button, .fab {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        min-height: 3rem;
        border-radius: 999px;
        border: 1px solid transparent;
        text-decoration: none;
        cursor: pointer;
      }
      .vote, .icon-button {
        min-width: 3.25rem;
        padding: 0.75rem 1rem;
        background: rgba(255,255,255,0.85);
        border-color: var(--line);
        color: var(--ink);
      }
      .vote.active.up { border-color: #8bc89a; color: var(--good); }
      .vote.active.down { border-color: #d4a7a7; color: var(--bad); }
      .icon-button {
        font-size: 1.2rem;
      }
      .vote-error {
        margin: 0 0 0.75rem;
        color: var(--muted);
      }
      .sheet-panel {
        position: relative;
        min-height: 100%;
        overflow: hidden;
      }
      .sheet-frame {
        min-height: 44rem;
        background: #fff;
      }
      .sheet-link {
        position: absolute;
        top: 0.85rem;
        right: 0.85rem;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.92);
        text-decoration: none;
        box-shadow: 0 0.3rem 1rem rgba(34, 24, 16, 0.08);
      }
      .empty-state {
        padding: 2rem;
        max-width: 32rem;
      }
      dialog {
        width: min(40rem, calc(100vw - 2rem));
        border: 0;
        border-radius: 1.25rem;
        padding: 0;
        background: transparent;
      }
      dialog::backdrop { background: rgba(32, 22, 15, 0.55); }
      .modal-card {
        background: var(--panel-solid);
        border: 1px solid var(--line);
        border-radius: 1.25rem;
        padding: 1rem;
      }
      .modal-head {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: start;
      }
      .modal-head h2 {
        margin: 0;
        font-size: 1.8rem;
      }
      .close {
        border: 0;
        background: transparent;
        cursor: pointer;
        font-size: 1.6rem;
        line-height: 1;
      }
      .field {
        display: grid;
        gap: 0.35rem;
        margin-top: 1rem;
      }
      .field input, .field textarea {
        width: 100%;
        padding: 0.75rem 0.85rem;
        border-radius: 0.9rem;
        border: 1px solid var(--line);
        background: #fff;
      }
      .field textarea { min-height: 8rem; resize: vertical; }
      .help { margin: 0; color: var(--muted); font-size: 0.9rem; }
      .tag-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 0.75rem;
      }
      .tag-choice {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
      }
      .modal-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 0.75rem;
        margin-top: 1rem;
      }
      .primary {
        min-height: 2.8rem;
        padding: 0.7rem 1rem;
        border-radius: 999px;
        border: 1px solid transparent;
        background: var(--accent);
        color: var(--accent-ink);
        cursor: pointer;
      }
      .fab {
        position: fixed;
        right: 1rem;
        bottom: 1rem;
        width: 3.75rem;
        height: 3.75rem;
        padding: 0;
        background: var(--accent);
        color: var(--accent-ink);
        box-shadow: 0 1rem 2rem rgba(165, 58, 27, 0.28);
        font-size: 2rem;
      }
      @media (max-width: 900px) {
        .tune-stage.has-sheet {
          grid-template-columns: 1fr;
        }
        .sheet-frame {
          min-height: 32rem;
        }
      }
      @media (max-width: 640px) {
        .shell {
          padding: 0.75rem 0.75rem 6rem;
        }
        .tune-meta,
        .modal-card,
        .empty-state {
          padding: 0.9rem;
        }
        .sheet-frame {
          min-height: 22rem;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      ${flash ? `<p class="flash ${flash.kind}">${escapeHtml(flash.message)}</p>` : ''}
      ${tuneSection}
    </main>

    <button class="fab" type="button" data-open-submit aria-label="Submit a tune" title="Submit a tune">+</button>

    <dialog data-submit-dialog${dialogOpen} aria-labelledby="submit-title">
      ${renderSubmissionPanel(tags, draft)}
    </dialog>

    <script src="https://unpkg.com/htmx.org@2/dist/htmx.min.js"></script>
    <script>
      const dialog = document.querySelector('[data-submit-dialog]');
      const openButtons = document.querySelectorAll('[data-open-submit]');
      for (const button of openButtons) {
        button.addEventListener('click', () => {
          if (dialog && typeof dialog.showModal === 'function') {
            dialog.showModal();
          } else if (dialog) {
            dialog.setAttribute('open', 'open');
          }
        });
      }
    </script>
  </body>
</html>`;
}

function renderModeratorHtml({
  flash,
  tags,
  tunes,
}: {
  flash?: Flash;
  tags: TagRow[];
  tunes: AdminTune[];
}): string {
  const pendingCount = tunes.filter((tune) => !tune.date_accepted).length;
  const acceptedCount = tunes.length - pendingCount;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>kustode · jams.dk</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f3ee;
        --card: #fff;
        --ink: #1d1b17;
        --muted: #6a6358;
        --line: #d7d1c6;
        --accent: #2f584a;
        --warn: #8c2c2c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 16px/1.5 system-ui, sans-serif;
        color: var(--ink);
        background: var(--bg);
      }
      button, input, textarea { font: inherit; }
      .shell {
        max-width: 78rem;
        margin: 0 auto;
        padding: 1.5rem 1rem 4rem;
      }
      .top {
        display: grid;
        gap: 1rem;
        margin-bottom: 1.5rem;
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 7vw, 3rem);
      }
      .muted { color: var(--muted); }
      .stats {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
      }
      .chip, .tag {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 0.3rem 0.75rem;
        background: #fff;
      }
      .flash {
        margin: 0 0 1rem;
        padding: 0.85rem 1rem;
        border-radius: 1rem;
        background: #fff;
        border: 1px solid var(--line);
      }
      .flash.error { border-color: #d5aaaa; color: #6f2424; }
      .flash.success { border-color: #b8d1bf; color: #1d5931; }
      .panel, .tune {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 1.25rem;
        padding: 1rem;
        box-shadow: 0 0.6rem 1.5rem rgba(29, 27, 23, 0.04);
      }
      .panel { margin-bottom: 1rem; }
      .field {
        display: grid;
        gap: 0.35rem;
        margin-top: 0.85rem;
      }
      .field input, .field textarea {
        width: 100%;
        padding: 0.7rem 0.8rem;
        border: 1px solid var(--line);
        border-radius: 0.9rem;
      }
      .field textarea { min-height: 7rem; resize: vertical; }
      .tag-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 0.8rem;
        margin-top: 0.6rem;
      }
      .tag-choice {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
      }
      .queue {
        display: grid;
        gap: 1rem;
      }
      .tune h2 {
        margin: 0 0 0.35rem;
        font-size: 1.5rem;
      }
      .meta {
        margin: 0;
        color: var(--muted);
        font-size: 0.95rem;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-top: 1rem;
      }
      .primary, .secondary, .danger {
        min-height: 2.7rem;
        padding: 0.7rem 1rem;
        border-radius: 999px;
        border: 1px solid transparent;
        cursor: pointer;
      }
      .primary {
        background: var(--accent);
        color: #fff;
      }
      .secondary {
        background: #fff;
        border-color: var(--line);
      }
      .danger {
        background: #fff;
        color: var(--warn);
        border-color: #dfb8b8;
      }
      @media (max-width: 720px) {
        .shell { padding-top: 1rem; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="top">
        <h1>kustode</h1>
        <p class="muted">Review submissions, fix metadata, mint tags, and decide what goes live.</p>
        <div class="stats">
          <span class="chip">pending: ${pendingCount}</span>
          <span class="chip">accepted: ${acceptedCount}</span>
          <span class="chip">tags: ${tags.length}</span>
        </div>
      </header>

      ${flash ? `<p class="flash ${flash.kind}">${escapeHtml(flash.message)}</p>` : ''}

      <section class="panel">
        <h2>Create tag</h2>
        <form method="post" action="/kustode/tags">
          <label class="field">
            <span>Tag name</span>
            <input name="name" maxlength="${MAX_TAG_LENGTH}" placeholder="irish" required>
          </label>
          <div class="actions">
            <button class="primary" type="submit">Create tag</button>
          </div>
        </form>
      </section>

      <section class="queue">
        ${
          tunes.length
            ? tunes.map((tune) => renderModeratorTuneCard(tune, tags)).join('')
            : '<article class="tune"><h2>No tunes yet.</h2><p class="meta">Use the public submission form on the front page to start the pile.</p></article>'
        }
      </section>
    </main>
  </body>
</html>`;
}

function renderModeratorTuneCard(tune: AdminTune, allTags: TagRow[]): string {
  const selectedTagIds = new Set(tune.tags.map((tag) => tag.id));
  const status = tune.date_accepted ? 'accepted' : 'pending';
  const statusLine = tune.date_accepted
    ? `accepted ${escapeHtml(formatDate(tune.date_accepted))}`
    : `submitted ${escapeHtml(formatDate(tune.date_added))}`;

  return `
    <article class="tune">
      <h2>${escapeHtml(tune.title)}</h2>
      <p class="meta">${statusLine} · 👍 ${tune.upvotes} · 👎 ${tune.downvotes} · from ${escapeHtml(tune.submitted_ip)}</p>
      <form method="post" action="/kustode/tunes/${tune.id}/save">
        <label class="field">
          <span>Title</span>
          <input name="title" maxlength="${MAX_TITLE_LENGTH}" value="${escapeHtml(tune.title)}" required>
        </label>
        <label class="field">
          <span>YouTube URL or video ID</span>
          <input name="youtube_identifier" value="${escapeHtml(tune.youtube_identifier)}" required>
        </label>
        <label class="field">
          <span>Sheet music link</span>
          <input name="sheet_music_reference" type="url" value="${escapeHtml(tune.sheet_music_reference ?? '')}">
        </label>
        <label class="field">
          <span>Notes</span>
          <textarea name="notes" maxlength="${MAX_NOTES_LENGTH}">${escapeHtml(tune.notes)}</textarea>
        </label>
        <div class="field">
          <span>Tags</span>
          ${
            allTags.length
              ? `<div class="tag-grid">${allTags
                  .map(
                    (tag) => `<label class="tag-choice"><input type="checkbox" name="tag_ids" value="${tag.id}" ${selectedTagIds.has(tag.id) ? 'checked' : ''}> <span>${escapeHtml(tag.name)}</span></label>`,
                  )
                  .join('')}</div>`
              : '<p class="meta">No tags yet.</p>'
          }
        </div>
        <div class="actions">
          <button class="secondary" type="submit" formaction="/kustode/tunes/${tune.id}/save">Save</button>
          ${
            status === 'pending'
              ? `<button class="primary" type="submit" formaction="/kustode/tunes/${tune.id}/accept">Accept</button>
                 <button class="danger" type="submit" formaction="/kustode/tunes/${tune.id}/delete">Reject</button>`
              : `<button class="secondary" type="submit" formaction="/kustode/tunes/${tune.id}/pending">Make pending</button>
                 <button class="danger" type="submit" formaction="/kustode/tunes/${tune.id}/delete">Delete</button>`
          }
        </div>
      </form>
    </article>
  `;
}

function renderTagBadges(tags: TagRow[]): string {
  if (!tags.length) return '';
  return `<ul class="badges">${tags.map((tag) => `<li class="badge">${escapeHtml(tag.name)}</li>`).join('')}</ul>`;
}

function formatDate(value: string): string {
  return value.replace('T', ' ').replace('Z', ' UTC');
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
