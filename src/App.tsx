import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import './App.css'

type Person = 'Ofelia' | 'Andrea'
type View = 'pending' | 'paid'
type Expense = {
  id: string
  person: Person
  description: string
  cents: number
  dueDate: string | null
  email: string | null
  status: 'pending' | 'paid'
  createdAt: string
  paidAt: string | null
}
type Action = { id: string; kind: 'pay' | 'discard' }
type FieldErrors = Partial<Record<'description' | 'amount' | 'date' | 'email', string>>
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/\/$/, '')
const TOKEN_KEY = 'gastos-ofe-api-token'
const THEME_KEY = 'gastos-ofe-theme'
const PEOPLE: Person[] = ['Ofelia', 'Andrea']
const moneyFormatter = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })
const integerFormatter = new Intl.NumberFormat('es-AR')
const dateFormatter = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
})
const dateTimeFormatter = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function api<T>(token: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...options.headers },
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : `Error ${response.status}`
    throw new ApiError(message, response.status)
  }
  return data as T
}

function formatInput(raw: string): string {
  const cleaned = raw.replace(/[^\d,]/g, '')
  const comma = cleaned.indexOf(',')
  const whole = (comma < 0 ? cleaned : cleaned.slice(0, comma)).slice(0, 12)
  const decimals = comma < 0 ? '' : cleaned.slice(comma + 1).replace(/,/g, '').slice(0, 2)
  return (whole ? integerFormatter.format(Number(whole)) : '') +
    (comma < 0 ? '' : ',' + decimals)
}

function parseCents(value: string): number | null {
  const normalized = value.replace(/\./g, '')
  if (!/^\d+(,\d{0,2})?$/.test(normalized)) return null
  const [whole, fraction = ''] = normalized.split(',')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

function formatDate(value: string | null): string {
  return value ? dateFormatter.format(new Date(`${value}T00:00:00Z`)) : 'Sin fecha'
}

export default function App() {
  const [person, setPerson] = useState<Person>('Ofelia')
  const [view, setView] = useState<View>('pending')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light')
  const [tokenInput, setTokenInput] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [loading, setLoading] = useState(Boolean(token))
  const [working, setWorking] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formPerson, setFormPerson] = useState<Person>('Ofelia')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [unknownDate, setUnknownDate] = useState(false)
  const [useEmail, setUseEmail] = useState(false)
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [action, setAction] = useState<Action | null>(null)
  const [notice, setNotice] = useState('')
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const addDialog = useRef<HTMLDialogElement>(null)
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const descriptionInput = useRef<HTMLInputElement>(null)
  const amountInput = useRef<HTMLInputElement>(null)
  const dateInput = useRef<HTMLInputElement>(null)
  const emailInput = useRef<HTMLInputElement>(null)
  const tabRefs = useRef<Record<Person, HTMLButtonElement | null>>({ Ofelia: null, Andrea: null })
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pending = expenses.filter(item => item.person === person && item.status === 'pending')
  const paid = expenses
    .filter(item => item.person === person && item.status === 'paid')
    .sort((left, right) => (right.paidAt || '').localeCompare(left.paidAt || ''))
  const visibleExpenses = view === 'pending' ? pending : paid
  const total = visibleExpenses.reduce((sum, item) => sum + item.cents, 0)
  const selectedExpense = expenses.find(item => item.id === action?.id && item.status === 'pending')

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme)
    document.documentElement.style.colorScheme = theme
    return () => { document.documentElement.style.colorScheme = '' }
  }, [theme])

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onInstallPrompt)
  }, [])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    api<Expense[]>(token, '/api/expenses')
      .then(items => { if (!cancelled) { setExpenses(items); setConnectionError('') } })
      .catch(error => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'No se pudo conectar.'
        setConnectionError(message)
        if (error instanceof ApiError && (error.status === 401 || error.status === 429)) {
          sessionStorage.removeItem(TOKEN_KEY)
          setToken('')
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = tokenInput.trim()
    if (!next) return
    sessionStorage.setItem(TOKEN_KEY, next)
    setConnectionError('')
    setLoading(true)
    setToken(next)
    setTokenInput('')
  }

  async function installApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  function flash(message: string) {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(''), 3500)
  }

  function openAdd() {
    setEditingId(null)
    setFormPerson(person)
    setDescription('')
    setAmount('')
    setDueDate('')
    setUnknownDate(false)
    setUseEmail(false)
    setEmail('')
    setErrors({})
    addDialog.current?.showModal()
    descriptionInput.current?.focus()
  }

  function openEdit(item: Expense) {
    setEditingId(item.id)
    setFormPerson(item.person)
    setDescription(item.description)
    setAmount(formatInput((item.cents / 100).toFixed(2).replace('.', ',')))
    setDueDate(item.dueDate || '')
    setUnknownDate(!item.dueDate)
    setUseEmail(Boolean(item.email))
    setEmail(item.email || '')
    setErrors({})
    addDialog.current?.showModal()
    descriptionInput.current?.focus()
  }

  async function saveExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (working) return
    const cleanDescription = description.trim()
    const cents = parseCents(amount)
    const cleanEmail = dueDate && !unknownDate && useEmail ? email.trim() : ''
    const nextErrors: FieldErrors = {}
    if (!cleanDescription) nextErrors.description = 'Ingresá una descripción.'
    if (cents === null) nextErrors.amount = 'Ingresá un importe mayor a cero.'
    if (!unknownDate && !dueDate) nextErrors.date = 'Elegí una fecha o marcá que no la sabés.'
    if (dueDate && !unknownDate && useEmail && !cleanEmail) nextErrors.email = 'Ingresá un correo o desmarcá esta opción.'
    else if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) nextErrors.email = 'Ingresá un correo válido.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      const first = nextErrors.description ? descriptionInput : nextErrors.amount ? amountInput : nextErrors.date ? dateInput : emailInput
      first.current?.focus()
      return
    }
    if (!cleanDescription || cents === null) return
    setWorking(true)
    try {
      const item = await api<Expense>(token, editingId ? `/api/expenses/${editingId}` : '/api/expenses', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify({ person: formPerson, description: cleanDescription, cents, dueDate: unknownDate ? null : dueDate, email: cleanEmail }),
      })
      setExpenses(previous => editingId ? previous.map(existing => existing.id === item.id ? item : existing) : [item, ...previous])
      addDialog.current?.close()
      setEditingId(null)
      flash(editingId ? 'Gasto actualizado.' : 'Gasto agregado.')
    } catch (error) {
      flash(error instanceof Error ? error.message : 'No se pudo guardar el gasto.')
    } finally { setWorking(false) }
  }

  function ask(kind: Action['kind'], id: string) {
    setAction({ kind, id })
    confirmDialog.current?.showModal()
  }

  function closeConfirm() {
    confirmDialog.current?.close()
    setAction(null)
  }

  async function confirm() {
    if (!action || !selectedExpense) return
    setWorking(true)
    try {
      const { kind, id } = action
      if (kind === 'pay') {
        const paidExpense = await api<Expense>(token, `/api/expenses/${id}/pay`, { method: 'PATCH' })
        setExpenses(previous => previous.map(item => item.id === id ? paidExpense : item))
      } else {
        await api(token, `/api/expenses/${id}`, { method: 'DELETE' })
        setExpenses(previous => previous.filter(item => item.id !== id))
      }
      closeConfirm()
      flash(kind === 'pay' ? 'Gasto pagado y guardado en el historial.' : 'Gasto descartado.')
    } catch (error) {
      flash(error instanceof Error ? error.message : 'No se pudo actualizar el gasto.')
    } finally { setWorking(false) }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? PEOPLE[0] : event.key === 'End' ? PEOPLE[1] : PEOPLE[1 - PEOPLE.indexOf(person)]
    setPerson(next)
    tabRefs.current[next]?.focus()
  }

  return (
    <div className="go-app" data-theme={theme}>
      <header className="go-topbar">
        <div className="go-topbar-inner"><div className="go-logo" aria-hidden="true">$</div><div className="go-brand">Gastos-Ofe</div><div className="go-topbar-actions">{installPrompt && <button className="go-install" type="button" onClick={installApp}>Instalar app</button>}<button className="go-theme-toggle" type="button" onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')} aria-label={`Activar modo ${theme === 'light' ? 'oscuro' : 'claro'}`} aria-pressed={theme === 'dark'}>{theme === 'light' ? '☾ Modo oscuro' : '☀ Modo claro'}</button>{token && <button className="go-switch-key" type="button" onClick={() => { sessionStorage.removeItem(TOKEN_KEY); setLoading(false); setToken(''); setExpenses([]) }}>Cambiar clave</button>}</div></div>
      </header>
      {!token ? (
        <main className="go-main"><form className="go-auth" onSubmit={connect}>
          <h1>Conectar Gastos-Ofe</h1>
          <p>Ingresá la clave de la app para consultar y guardar los gastos.</p>
          <label className="go-field-label" htmlFor="go-token">Clave</label>
          <input id="go-token" type="password" value={tokenInput} onChange={event => setTokenInput(event.target.value)} autoComplete="off" required />
          {connectionError && <p className="go-error" role="alert">{connectionError}</p>}
          <button className="go-primary" type="submit">Conectar</button>
        </form></main>
      ) : loading ? <main className="go-main"><p role="status">Cargando gastos…</p></main> : connectionError ? (
        <main className="go-main"><div className="go-auth"><h1>No se pudo conectar</h1><p role="alert">{connectionError}</p><button className="go-primary" type="button" onClick={() => window.location.reload()}>Reintentar</button></div></main>
      ) : (
      <main className="go-main">
        <div className="go-heading">
          <div><h1>{view === 'pending' ? 'Gastos pendientes' : 'Historial de pagos'}</h1><p>{view === 'pending' ? 'Organizá los gastos de Ofelia y Andrea.' : 'Consultá los gastos que ya fueron pagados.'}</p></div>
          <button className="go-primary" type="button" onClick={openAdd}>+ Agregar gasto</button>
        </div>
        <div className="go-view-tabs" role="tablist" aria-label="Estado de los gastos">
          <button type="button" role="tab" aria-selected={view === 'pending'} onClick={() => setView('pending')}>Pendientes</button>
          <button type="button" role="tab" aria-selected={view === 'paid'} onClick={() => setView('paid')}>Historial</button>
        </div>
        <div className="go-toolbar">
          <div className="go-tabs" role="tablist" aria-label="Persona">
            {PEOPLE.map(name => (
              <button key={name} ref={element => { tabRefs.current[name] = element }}
                className="go-tab" role="tab" id={`tab-${name.toLowerCase()}`}
                aria-controls="expense-panel" aria-selected={person === name}
                tabIndex={person === name ? 0 : -1} onClick={() => setPerson(name)} onKeyDown={onTabKeyDown}>
                {name}
              </button>
            ))}
          </div>
          <div className="go-summary" aria-live="polite">
            {visibleExpenses.length} {visibleExpenses.length === 1 ? (view === 'pending' ? 'gasto pendiente' : 'gasto pagado') : (view === 'pending' ? 'gastos pendientes' : 'gastos pagados')} · {moneyFormatter.format(total / 100)}
          </div>
        </div>
        <section className="go-surface" id="expense-panel" role="tabpanel" aria-labelledby={`tab-${person.toLowerCase()}`}>
          {visibleExpenses.length ? (
            <div className="go-table-scroll">
              {view === 'pending' ? <table><thead><tr><th scope="col">Descripción</th><th scope="col">Importe</th><th scope="col">Vencimiento</th><th scope="col">Correo</th><th scope="col">Acciones</th></tr></thead>
                <tbody>{pending.map(item => (
                  <tr key={item.id}>
                    <td className="go-description">{item.description}</td>
                    <td className="go-amount">{moneyFormatter.format(item.cents / 100)}</td>
                    <td className="go-date">{formatDate(item.dueDate)}</td>
                    <td className={`go-email-cell ${item.email ? '' : 'go-email-empty'}`}><span className="go-mobile-label">Correo: </span>{item.email || 'Sin correo'}</td>
                    <td><div className="go-actions">
                      <button className="go-icon-btn go-edit" type="button" title="Editar gasto" aria-label={`Editar ${item.description}`} onClick={() => openEdit(item)}>✎</button>
                      <button className="go-icon-btn go-pay" type="button" title="Marcar como pagado" aria-label={`Marcar ${item.description} como pagado`} onClick={() => ask('pay', item.id)}>✓</button>
                      <button className="go-icon-btn go-discard" type="button" title="Descartar gasto" aria-label={`Descartar ${item.description}`} onClick={() => ask('discard', item.id)}>×</button>
                    </div></td>
                  </tr>
                ))}</tbody></table> : <table className="go-history-table"><thead><tr><th scope="col">Descripción</th><th scope="col">Importe</th><th scope="col">Vencimiento</th><th scope="col">Pagado</th></tr></thead>
                <tbody>{paid.map(item => (
                  <tr key={item.id}>
                    <td className="go-description">{item.description}</td>
                    <td className="go-amount">{moneyFormatter.format(item.cents / 100)}</td>
                    <td className="go-date">{formatDate(item.dueDate)}</td>
                    <td className="go-date"><span className="go-mobile-label">Pagado: </span>{item.paidAt ? dateTimeFormatter.format(new Date(item.paidAt)) : 'Sin fecha'}</td>
                  </tr>
                ))}</tbody></table>}
            </div>
          ) : (
            <div className="go-empty"><div className="go-empty-icon" aria-hidden="true">✓</div><h2>{view === 'pending' ? 'No hay gastos pendientes' : 'Todavía no hay pagos'}</h2><p>{view === 'pending' ? 'Agregá un gasto para empezar.' : 'Los gastos pagados aparecerán acá.'}</p></div>
          )}
        </section>
        <p className="go-storage-note">Los gastos se guardan en la base de datos de la app.</p>
      </main>
      )}

      <dialog ref={addDialog} className="go-dialog go-add-dialog" aria-labelledby="go-add-title" onClose={() => setEditingId(null)} onClick={event => { if (event.target === event.currentTarget && !working) addDialog.current?.close() }}>
        <form className="go-dialog-content go-add-form" onSubmit={saveExpense} noValidate>
          <div className="go-dialog-head go-add-head">
            <div><h2 id="go-add-title">{editingId ? 'Editar gasto' : 'Agregar gasto'}</h2><p className="go-dialog-kicker">Para {formPerson}</p></div>
            <button className="go-close" type="button" aria-label="Cerrar" disabled={working} onClick={() => addDialog.current?.close()}>×</button>
          </div>
          <div className="go-add-body">
            {editingId && <div className="go-field"><label className="go-field-label" htmlFor="go-person">Persona</label><select id="go-person" value={formPerson} onChange={event => setFormPerson(event.target.value as Person)}>{PEOPLE.map(name => <option key={name} value={name}>{name}</option>)}</select></div>}
            <div className="go-field">
              <label className="go-field-label" htmlFor="go-description">Descripción</label>
              <input ref={descriptionInput} id="go-description" type="text" value={description} maxLength={120} autoComplete="off" placeholder="Ej.: Internet" aria-invalid={Boolean(errors.description)} aria-describedby="go-description-error" onChange={event => setDescription(event.target.value)} />
              <p id="go-description-error" className="go-error" role="alert">{errors.description}</p>
            </div>
            <div className="go-field go-amount-field">
              <label className="go-field-label" htmlFor="go-amount">Importe</label>
              <div className="go-money"><span aria-hidden="true">$</span><input ref={amountInput} id="go-amount" type="text" value={amount} inputMode="decimal" autoComplete="off" placeholder="0,00" aria-invalid={Boolean(errors.amount)} aria-describedby="go-amount-error" onChange={event => setAmount(formatInput(event.target.value))} /></div>
              <p id="go-amount-error" className="go-error" role="alert">{errors.amount}</p>
            </div>
            <div className="go-field go-date-group">
              <label className="go-field-label" htmlFor="go-date">Vencimiento</label>
              <input ref={dateInput} id="go-date" type="date" value={dueDate} disabled={unknownDate} aria-invalid={Boolean(errors.date)} aria-describedby="go-date-error" onChange={event => { setDueDate(event.target.value); if (!event.target.value) { setUseEmail(false); setEmail('') } }} />
              <label className="go-check-row"><input type="checkbox" checked={unknownDate} onChange={event => { setUnknownDate(event.target.checked); if (event.target.checked) { setDueDate(''); setUseEmail(false); setEmail('') } }} /><span>No sé la fecha de vencimiento</span></label>
              <p id="go-date-error" className="go-error" role="alert">{errors.date}</p>
            </div>
            {dueDate && !unknownDate && <div className="go-reminder-panel">
              <label className="go-check-row go-reminder-choice"><input type="checkbox" checked={useEmail} onChange={event => { setUseEmail(event.target.checked); if (!event.target.checked) setEmail('') }} /><span><strong>Recordatorios por correo</strong><small>2 días antes, 1 día antes y al vencer.</small></span></label>
              {useEmail && <div className="go-field go-email-field">
                <label className="go-field-label" htmlFor="go-email">Correo electrónico</label>
                <input ref={emailInput} id="go-email" type="email" inputMode="email" autoComplete="email" value={email} placeholder="nombre@ejemplo.com" aria-invalid={Boolean(errors.email)} aria-describedby="go-email-hint go-email-error" onChange={event => setEmail(event.target.value)} />
                <p id="go-email-hint" className="go-hint">Solo mientras el gasto esté pendiente.</p>
                <p id="go-email-error" className="go-error" role="alert">{errors.email}</p>
              </div>}
            </div>}
          </div>
          <div className="go-dialog-actions go-add-actions">
            <button className="go-secondary" type="button" disabled={working} onClick={() => addDialog.current?.close()}>Cancelar</button>
            <button className="go-primary" type="submit" disabled={working}>{working ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Guardar gasto'}</button>
          </div>
        </form>
      </dialog>

      <dialog ref={confirmDialog} className="go-dialog" aria-labelledby="go-confirm-title" aria-describedby="go-confirm-text" onClose={() => setAction(null)} onClick={event => { if (event.target === event.currentTarget) closeConfirm() }}>
        <div className="go-dialog-content"><div className="go-dialog-head"><h2 id="go-confirm-title">{action?.kind === 'pay' ? '¿Marcar como pagado?' : '¿Descartar gasto?'}</h2><button className="go-close" type="button" aria-label="Cerrar" onClick={closeConfirm}>×</button></div>
          <p className="go-confirm-text" id="go-confirm-text">{selectedExpense && (action?.kind === 'pay'
            ? `“${selectedExpense.description}” (${moneyFormatter.format(selectedExpense.cents / 100)}) pasará al historial y no se enviarán más avisos.`
            : `Se eliminará “${selectedExpense.description}” (${moneyFormatter.format(selectedExpense.cents / 100)}) definitivamente.`)}</p>
          <div className="go-dialog-actions"><button className="go-secondary" type="button" disabled={working} onClick={closeConfirm}>No, cancelar</button><button className={`go-primary ${action?.kind === 'discard' ? 'go-danger' : ''}`} type="button" disabled={working} onClick={confirm}>{working ? 'Guardando…' : 'Sí, confirmar'}</button></div>
        </div>
      </dialog>
      {notice && <div className="go-toast" role="status">{notice}</div>}
    </div>
  )
}
