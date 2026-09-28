import './index.css'

// Fork ModelInk3D: com VITE_CALC_SERVER=1 o app roda atrás do servidor
// (server/) — login obrigatório e dados sincronizados. Os dados do servidor
// precisam estar no localStorage ANTES de qualquer store ser importado (eles
// hidratam no import), por isso App, i18n e tema entram por import dinâmico.
const SERVER_MODE = import.meta.env.VITE_CALC_SERVER === '1'

async function render(): Promise<void> {
  const [{ default: React }, { default: ReactDOM }, { default: App }, { initTheme }, { default: i18n }] =
    await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('@/platform/web/App'),
      import('@/shared/hooks/useTheme'),
      import('@/shared/i18n/i18n'),
    ])

  if (SERVER_MODE) {
    const { applyServerModeTexts } = await import('./sync/i18nOverrides')
    applyServerModeTexts(i18n)
  }

  // Initialize theme BEFORE React renders to prevent flash of wrong theme.
  initTheme()

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

function showBootError(retry: () => void): void {
  const root = document.getElementById('root')!
  root.innerHTML = `
    <div style="min-height:100dvh;display:grid;place-items:center;padding:16px;font-family:system-ui,sans-serif;background:#0a0f14;color:#e2e8f0">
      <div style="max-width:360px;text-align:center">
        <p style="font-size:18px;font-weight:600;margin:0 0 8px">Não foi possível conectar ao servidor</p>
        <p style="font-size:14px;color:#94a3b8;margin:0 0 20px">Os dados ficam no servidor da ModelInk3D. Verifique a internet e tente de novo.</p>
        <button id="boot-retry" style="padding:10px 20px;border:0;border-radius:10px;background:#0969b5;color:#fff;font:inherit;font-weight:600;cursor:pointer">Tentar de novo</button>
      </div>
    </div>`
  document.getElementById('boot-retry')!.addEventListener('click', retry, { once: true })
}

async function boot(): Promise<void> {
  if (!SERVER_MODE) {
    await render()
    return
  }
  const { bootSync, startSync } = await import('./sync/engine')
  try {
    await bootSync()
  } catch (error) {
    console.error('[sync] boot falhou:', error)
    showBootError(() => location.reload())
    return
  }
  await render()
  const { rehydrateKey } = await import('./sync/rehydrate')
  startSync(rehydrateKey)
}

void boot()
