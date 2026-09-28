interface Env {
  DB: D1Database
  APP_TOKEN: string
  GMAIL_CLIENT_ID: string
  GMAIL_CLIENT_SECRET: string
  GMAIL_REFRESH_TOKEN: string
  GMAIL_FROM: string
  ALLOWED_ORIGINS: string
}

type Person = 'Ofelia' | 'Andrea'
type Status = 'pending' | 'paid'
type Expense = {
  id: string
  person: Person
  description: string
  cents: number
  dueDate: string | null
  email: string | null
  status: Status
  createdAt: string
  paidAt: string | null
}
type ExpenseRow = {
  id: string
  person: Person
  description: string
  cents: number
  due_date: string | null
  email: string | null
  status: Status
  created_at: string
  paid_at: string | null
}
type NewExpense = {
  person?: unknown
  description?: unknown
  cents?: unknown
  dueDate?: unknown
  email?: unknown
}

const TIME_ZONE = 'America/Argentina/Buenos_Aires'
const TOKEN_API = 'https://oauth2.googleapis.com/token'
const MAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const AUTH_WINDOW_SECONDS = 15 * 60
const AUTH_MAX_ATTEMPTS = 5

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get('origin')
  const allowed = env.ALLOWED_ORIGINS.split(',').map(value => value.trim())
  return origin && allowed.includes(origin)
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
        vary: 'Origin',
      }
    : { vary: 'Origin' }
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)])
  let difference = 0
  for (let index = 0; index < leftDigest.length; index++) {
    difference |= leftDigest.charCodeAt(index) ^ rightDigest.charCodeAt(index)
  }
  return difference === 0
}

async function authenticate(request: Request, env: Env, headers: HeadersInit): Promise<Response | null> {
  if (!env.APP_TOKEN) return json({ error: 'API sin configurar' }, 503, headers)

  const now = Math.floor(Date.now() / 1000)
  const address = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown'
  const fingerprint = await digest(`${env.APP_TOKEN}:${address}`)
  const previous = await env.DB.prepare(`
    SELECT attempt_count, window_started_at, blocked_until
    FROM auth_failures WHERE fingerprint = ?
  `).bind(fingerprint).first<{ attempt_count: number; window_started_at: number; blocked_until: number | null }>()

  if (previous?.blocked_until && previous.blocked_until > now) {
    const retryAfter = previous.blocked_until - now
    return json(
      { error: `Demasiados intentos. Probá nuevamente en ${Math.ceil(retryAfter / 60)} minutos.` },
      429,
      { ...headers, 'retry-after': String(retryAfter) },
    )
  }

  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || ''
  if (await secureEqual(supplied, env.APP_TOKEN)) {
    if (previous) await env.DB.prepare('DELETE FROM auth_failures WHERE fingerprint = ?').bind(fingerprint).run()
    return null
  }

  const sameWindow = Boolean(previous && now - previous.window_started_at < AUTH_WINDOW_SECONDS)
  const attemptCount = sameWindow ? previous!.attempt_count + 1 : 1
  const windowStartedAt = sameWindow ? previous!.window_started_at : now
  const blockedUntil = attemptCount >= AUTH_MAX_ATTEMPTS ? now + AUTH_WINDOW_SECONDS : null
  await env.DB.prepare(`
    INSERT INTO auth_failures (fingerprint, attempt_count, window_started_at, blocked_until, last_failed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      attempt_count = excluded.attempt_count,
      window_started_at = excluded.window_started_at,
      blocked_until = excluded.blocked_until,
      last_failed_at = excluded.last_failed_at
  `).bind(fingerprint, attemptCount, windowStartedAt, blockedUntil, new Date().toISOString()).run()

  if (blockedUntil) {
    return json(
      { error: 'Demasiados intentos. Probá nuevamente en 15 minutos.' },
      429,
      { ...headers, 'retry-after': String(AUTH_WINDOW_SECONDS) },
    )
  }
  return json({ error: `Clave incorrecta. Quedan ${AUTH_MAX_ATTEMPTS - attemptCount} intentos.` }, 401, headers)
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function parseExpense(input: NewExpense): Omit<Expense, 'id' | 'status' | 'createdAt' | 'paidAt'> | null {
  if (!input || typeof input !== 'object') return null
  const person = input.person
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const cents = input.cents
  const dueDate = input.dueDate === null ? null : input.dueDate
  const email = typeof input.email === 'string' ? input.email.trim() : ''
  if (person !== 'Ofelia' && person !== 'Andrea') return null
  if (!description || description.length > 120) return null
  if (!Number.isSafeInteger(cents) || typeof cents !== 'number' || cents <= 0) return null
  if (dueDate !== null && !validDate(dueDate)) return null
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return null
  // Sin vencimiento no existen los hitos de 2 días, 1 día y día cero.
  if (email && !dueDate) return null
  return { person, description, cents, dueDate, email: email || null }
}

function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id, person: row.person, description: row.description,
    cents: row.cents, dueDate: row.due_date, email: row.email,
    status: row.status, createdAt: row.created_at, paidAt: row.paid_at,
  }
}

async function deletePendingExpense(env: Env, id: string): Promise<boolean> {
  const [, deleted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM reminders WHERE expense_id = ?').bind(id),
    env.DB.prepare("DELETE FROM expenses WHERE id = ? AND status = 'pending'").bind(id),
  ])
  return Boolean(deleted.meta.changes)
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const headers = corsHeaders(request, env)
  const origin = request.headers.get('origin')
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: origin && 'access-control-allow-origin' in headers ? 204 : 403, headers })
  }
  if (origin && !('access-control-allow-origin' in headers)) return json({ error: 'Origen no permitido' }, 403, headers)
  const authError = await authenticate(request, env, headers)
  if (authError) return authError

  const { pathname } = new URL(request.url)
  try {
    if (pathname === '/api/expenses' && request.method === 'GET') {
      const result = await env.DB.prepare('SELECT * FROM expenses ORDER BY created_at DESC').all<ExpenseRow>()
      return json(result.results.map(toExpense), 200, headers)
    }
    if (pathname === '/api/expenses' && request.method === 'POST') {
      let body: NewExpense
      try { body = await request.json() as NewExpense } catch { return json({ error: 'JSON inválido' }, 400, headers) }
      const input = parseExpense(body)
      if (!input) return json({ error: 'Revisá los datos. Si agregás un correo, el vencimiento es obligatorio.' }, 400, headers)
      const id = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      await env.DB.prepare(`
        INSERT INTO expenses (id, person, description, cents, due_date, email, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `).bind(id, input.person, input.description, input.cents, input.dueDate, input.email, createdAt).run()
      return json({ ...input, id, status: 'pending', createdAt, paidAt: null }, 201, headers)
    }
    const match = /^\/api\/expenses\/([0-9a-f-]{36})(?:\/(pay))?$/.exec(pathname)
    if (match && !match[2] && request.method === 'PATCH') {
      let body: NewExpense
      try { body = await request.json() as NewExpense } catch { return json({ error: 'JSON inválido' }, 400, headers) }
      const input = parseExpense(body)
      if (!input) return json({ error: 'Revisá los datos. Si agregás un correo, el vencimiento es obligatorio.' }, 400, headers)
      const previous = await env.DB.prepare('SELECT * FROM expenses WHERE id = ? AND status = ?')
        .bind(match[1], 'pending').first<ExpenseRow>()
      if (!previous) return json({ error: 'Gasto pendiente no encontrado' }, 404, headers)
      const statements = [env.DB.prepare(`
        UPDATE expenses SET person = ?, description = ?, cents = ?, due_date = ?, email = ?
        WHERE id = ? AND status = 'pending'
      `).bind(input.person, input.description, input.cents, input.dueDate, input.email, match[1])]
      // Si cambia el calendario o destinatario, los hitos anteriores ya no aplican.
      if (previous.due_date !== input.dueDate || previous.email !== input.email) {
        statements.push(env.DB.prepare('DELETE FROM reminders WHERE expense_id = ?').bind(match[1]))
      }
      const [updated] = await env.DB.batch(statements)
      if (!updated.meta.changes) return json({ error: 'Gasto pendiente no encontrado' }, 404, headers)
      const row = await env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(match[1]).first<ExpenseRow>()
      return json(toExpense(row!), 200, headers)
    }
    if (match && match[2] === 'pay' && request.method === 'PATCH') {
      const paidAt = new Date().toISOString()
      const [, updated] = await env.DB.batch([
        env.DB.prepare('DELETE FROM reminders WHERE expense_id = ?').bind(match[1]),
        env.DB.prepare("UPDATE expenses SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'")
          .bind(paidAt, match[1]),
      ])
      if (!updated.meta.changes) return json({ error: 'Gasto pendiente no encontrado' }, 404, headers)
      const row = await env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(match[1]).first<ExpenseRow>()
      return json(toExpense(row!), 200, headers)
    }
    if (match && !match[2] && request.method === 'DELETE') {
      const deleted = await deletePendingExpense(env, match[1])
      return deleted ? json({ ok: true }, 200, headers) : json({ error: 'Gasto pendiente no encontrado' }, 404, headers)
    }
    return json({ error: 'Ruta no encontrada' }, 404, headers)
  } catch (error) {
    console.error('API error', error)
    return json({ error: 'Error del servidor' }, 500, headers)
  }
}

function localClock(now: Date): { today: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: string) => parts.find(item => item.type === type)?.value || ''
  return { today: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) }
}

function plusDays(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date + count)).toISOString().slice(0, 10)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character)
}

function emailContent(expense: ExpenseRow, daysBefore: number) {
  const title = daysBefore === 0 ? 'Vence hoy' : daysBefore === 1 ? 'Vence mañana' : 'Vence en 2 días'
  const subject = `${title}: ${expense.description} -Casa de ${expense.person} · Gastos-Ofe`
  const amount = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(expense.cents / 100)
  const due = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(`${expense.due_date}T00:00:00Z`))
  const safeTitle = escapeHtml(title)
  const safeDescription = escapeHtml(expense.description)
  const safePerson = escapeHtml(expense.person)
  const safeAmount = escapeHtml(amount)
  const safeDue = escapeHtml(due)
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;background:#edf3f7;color:#182b43;font-family:Arial,Helvetica,sans-serif;padding:32px 12px">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;margin:auto;background:#fff;border:1px solid #d8e3ec;border-radius:16px;overflow:hidden">
      <tr><td style="background:#152942;color:#fff;padding:24px 30px;font-size:20px;font-weight:700">Gastos-Ofe</td></tr>
      <tr><td style="padding:32px 30px">
        <p style="display:inline-block;margin:0 0 18px;background:#e5f5f1;color:#08776e;border-radius:8px;padding:7px 11px;font-size:13px;font-weight:700">${safeTitle.toUpperCase()}</p>
        <h1 style="margin:0 0 12px;font-size:26px;line-height:1.2;color:#182b43">Recordatorio de vencimiento</h1>
        <p style="margin:0 0 26px;color:#52677d;line-height:1.6">Tenés un gasto pendiente de ${safePerson}.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f5f9fb;border-radius:12px;padding:18px">
          <tr><td style="padding:5px 8px;color:#63778b">Gasto</td><td style="padding:5px 8px;text-align:right;font-weight:700">${safeDescription}</td></tr>
          <tr><td style="padding:5px 8px;color:#63778b">Importe</td><td style="padding:5px 8px;text-align:right;font-weight:700">${safeAmount}</td></tr>
          <tr><td style="padding:5px 8px;color:#63778b">Vencimiento</td><td style="padding:5px 8px;text-align:right;font-weight:700">${safeDue}</td></tr>
        </table>
        <p style="margin:25px 0 0;color:#52677d;line-height:1.6">Si ya lo pagaste, marcá el gasto como pagado en la app para dejar de recibir avisos.</p>
      </td></tr>
      <tr><td style="padding:18px 30px;background:#f5f9fb;color:#718295;font-size:12px">Aviso automático de Gastos-Ofe.</td></tr>
    </table>
  </body></html>`
  const text = `${title}: ${expense.description}\n\nGasto de ${expense.person}\nImporte: ${amount}\nVencimiento: ${due}\n\nSi ya lo pagaste, marcalo en la app para dejar de recibir avisos.`
  return { subject, html, text }
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64Lines(value: string): string {
  return base64(value).match(/.{1,76}/g)?.join('\r\n') || ''
}

function mimeMessage(expense: ExpenseRow, daysBefore: number, from: string): string {
  const { subject, html, text } = emailContent(expense, daysBefore)
  const boundary = `gastos-ofe-${crypto.randomUUID()}`
  const mime = [
    `From: Gastos-Ofe <${from}>`,
    `To: <${expense.email}>`,
    `Subject: =?UTF-8?B?${base64(subject)}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
  return base64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function gmailAccessToken(env: Env): Promise<string> {
  const response = await fetch(TOKEN_API, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) throw new Error(`Google OAuth ${response.status}: ${await response.text()}`)
  const data = await response.json() as { access_token?: string }
  if (!data.access_token) throw new Error('Google no devolvió un access token')
  return data.access_token
}

async function sendReminder(expense: ExpenseRow, daysBefore: number, env: Env): Promise<void> {
  if (!env.GMAIL_FROM || !env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error('Faltan las credenciales de Gmail')
  }
  const accessToken = await gmailAccessToken(env)
  const response = await fetch(MAIL_API, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: mimeMessage(expense, daysBefore, env.GMAIL_FROM) }),
  })
  if (!response.ok) throw new Error(`Gmail ${response.status}: ${(await response.text()).slice(0, 400)}`)
}

async function runReminders(env: Env, now = new Date()): Promise<void> {
  const { today, hour } = localClock(now)
  if (hour < 9 || hour > 20) return
  const targets = [0, 1, 2].map(days => plusDays(today, days))
  const result = await env.DB.prepare(`
    SELECT * FROM expenses
    WHERE status = 'pending' AND email IS NOT NULL AND email != ''
      AND due_date IN (?, ?, ?)
  `).bind(...targets).all<ExpenseRow>()

  for (const expense of result.results) {
    const daysBefore = targets.indexOf(expense.due_date || '')
    if (daysBefore < 0) continue
    const leaseUntil = Math.floor(now.getTime() / 1000) + 600
    const claim = await env.DB.prepare(`
      INSERT INTO reminders (expense_id, due_date, days_before, status, lease_until)
      VALUES (?, ?, ?, 'sending', ?)
      ON CONFLICT(expense_id, due_date, days_before)
      DO UPDATE SET status = 'sending', lease_until = excluded.lease_until
      WHERE reminders.status = 'sending' AND reminders.lease_until < ?
      RETURNING expense_id
    `).bind(expense.id, expense.due_date, daysBefore, leaseUntil, Math.floor(now.getTime() / 1000)).first()
    if (!claim) continue

    try {
      // Volvemos a mirar el estado justo antes del envío: pagar o descartar cancela avisos.
      const current = await env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(expense.id).first<ExpenseRow>()
      if (!current || current.status !== 'pending' || current.email !== expense.email || current.due_date !== expense.due_date) {
        await env.DB.prepare('DELETE FROM reminders WHERE expense_id = ? AND due_date = ? AND days_before = ? AND status = ?')
          .bind(expense.id, expense.due_date, daysBefore, 'sending').run()
        continue
      }
      await sendReminder(current, daysBefore, env)
      await env.DB.prepare(`
        UPDATE reminders SET status = 'sent', sent_at = ?, lease_until = NULL
        WHERE expense_id = ? AND due_date = ? AND days_before = ?
      `).bind(now.toISOString(), expense.id, expense.due_date, daysBefore).run()
    } catch (error) {
      console.error('Reminder failed', expense.id, daysBefore, error)
      // El próximo cron podrá reintentar durante el mismo día.
      await env.DB.prepare('UPDATE reminders SET lease_until = 0 WHERE expense_id = ? AND due_date = ? AND days_before = ? AND status = ?')
        .bind(expense.id, expense.due_date, daysBefore, 'sending').run()
    }
  }
}

export { runReminders }

export default {
  fetch: handleApi,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReminders(env))
  },
} satisfies ExportedHandler<Env>
