interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

type Env = {
  DB: D1Database;
  BASIC_AUTH_USER: string;
  BASIC_AUTH_PASSWORD: string;
};

type Note = {
  id: number;
  text: string;
  created_at: string;
};

const MAX_NOTE_LENGTH = 500;
const AUTH_REALM = 'D1 notes';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!checkBasicAuth(request, env)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'www-authenticate': `Basic realm="${AUTH_REALM}"`,
        },
      });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return renderHome(env);
    }

    if (request.method === 'POST' && url.pathname === '/notes') {
      return createNote(request, env);
    }

    const deleteMatch = url.pathname.match(/^\/notes\/(\d+)\/delete$/);
    if (request.method === 'POST' && deleteMatch) {
      return deleteNote(request, env, Number(deleteMatch[1]));
    }

    return new Response('Not found', { status: 404 });
  },
};

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
  return username === env.BASIC_AUTH_USER && password === env.BASIC_AUTH_PASSWORD;
}

async function renderHome(env: Env, error = ''): Promise<Response> {
  const notes = await listNotes(env.DB);
  return html(renderPage(notes, error));
}

async function createNote(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const text = String(formData.get('text') ?? '').trim();

  if (!text) {
    return renderHome(env, 'Note text is required.');
  }

  if (text.length > MAX_NOTE_LENGTH) {
    return renderHome(env, `Keep notes under ${MAX_NOTE_LENGTH} characters.`);
  }

  await env.DB.prepare('INSERT INTO notes (text) VALUES (?)').bind(text).run();
  return Response.redirect(new URL('/', request.url), 303);
}

async function deleteNote(request: Request, env: Env, id: number): Promise<Response> {
  await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
  return Response.redirect(new URL('/', request.url), 303);
}

async function listNotes(db: D1Database): Promise<Note[]> {
  const { results } = await db
    .prepare('SELECT id, text, created_at FROM notes ORDER BY id DESC')
    .all<Note>();

  return results ?? [];
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function renderPage(notes: Note[], error: string): string {
  const items = notes.length
    ? `<ul class="notes">${notes
        .map(
          (note) => `
            <li>
              <div class="meta">#${note.id} · ${escapeHtml(note.created_at)} UTC</div>
              <pre>${escapeHtml(note.text)}</pre>
              <form method="post" action="/notes/${note.id}/delete">
                <button type="submit">Delete</button>
              </form>
            </li>`,
        )
        .join('')}</ul>`
    : '<p>No notes yet.</p>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>D1 notes</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 48rem; padding: 0 1rem; }
      h1 { margin-top: 0; }
      form { margin: 0; }
      textarea { box-sizing: border-box; width: 100%; min-height: 8rem; }
      button { cursor: pointer; }
      .error { color: #b00020; }
      .notes { display: grid; gap: 1rem; list-style: none; padding: 0; }
      .notes li { border: 1px solid color-mix(in oklab, canvasText 20%, canvas 80%); border-radius: 0.5rem; padding: 1rem; }
      .meta { color: color-mix(in oklab, canvasText 60%, canvas 40%); font-size: 0.875rem; margin-bottom: 0.5rem; }
      pre { margin: 0 0 1rem; white-space: pre-wrap; font: inherit; }
    </style>
  </head>
  <body>
    <h1>D1 notes</h1>
    <p>Minimal Cloudflare Worker + D1, no frontend framework.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/notes">
      <p>
        <label for="text">New note</label><br>
        <textarea id="text" name="text" maxlength="${MAX_NOTE_LENGTH}" required></textarea>
      </p>
      <p><button type="submit">Save</button></p>
    </form>
    <hr>
    ${items}
  </body>
</html>`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
