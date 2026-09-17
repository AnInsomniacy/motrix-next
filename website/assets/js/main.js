/**
 * @fileoverview Rayburst website behavior.
 *
 * Sections: scroll reveal, hero stats (GitHub API + count-up), pickers
 * (language / theme with View Transition reveal), download resolution
 * (OS detection + release assets + architecture modal), lightbox.
 *
 * Zero dependencies — modern browser APIs only.
 */

/* ═══ Scroll reveal ═════════════════════════════════════════════════ */
const revealObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible')
        revealObserver.unobserve(entry.target)
      }
    }
  },
  { threshold: 0.08, rootMargin: '0px 0px -40px 0px' },
)
document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el))
document.documentElement.classList.add('js')

/* ═══ Bento spotlight — cursor-following highlight ═══════════════════ */
document.querySelectorAll('.bcard').forEach((card) => {
  card.addEventListener('pointermove', (e) => {
    const rect = card.getBoundingClientRect()
    card.style.setProperty('--mx', `${e.clientX - rect.left}px`)
    card.style.setProperty('--my', `${e.clientY - rect.top}px`)
  })
})

/* ═══ Count-up animation for hero stats ═════════════════════════════ */
function reserveCountWidth(el, sample) {
  const probe = el.cloneNode()
  probe.removeAttribute('id')
  probe.classList.remove('loading')
  probe.textContent = sample
  Object.assign(probe.style, {
    position: 'fixed',
    inset: 'auto auto 100% 100%',
    inlineSize: 'max-content',
    visibility: 'hidden',
  })
  document.body.appendChild(probe)
  el.style.inlineSize = `${Math.ceil(probe.getBoundingClientRect().width)}px`
  probe.remove()
}

function compactNumberWidthSample(target) {
  if (target < 1000) return '0'.repeat(String(target).length)
  const thousandsDigits = String(Math.floor(target / 1000)).length
  return `${'0'.repeat(thousandsDigits)}.0k`
}

function countUp(el, target, format) {
  reserveCountWidth(el, compactNumberWidthSample(target))

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = format(target)
    return
  }

  const duration = 900
  const start = performance.now()
  function frame(now) {
    const t = Math.min((now - start) / duration, 1)
    const eased = 1 - Math.pow(1 - t, 3)
    el.textContent = format(Math.round(target * eased))
    if (t < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function compactNumber(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

/* ═══ Language picker ═══════════════════════════════════════════════ */
const langToggle = document.getElementById('lang-toggle')
const langDropdown = document.getElementById('lang-dropdown')

langToggle.addEventListener('click', (e) => {
  e.stopPropagation()
  langDropdown.classList.toggle('open')
})

document.addEventListener('click', () => langDropdown.classList.remove('open'))

langDropdown.addEventListener('click', (e) => {
  const btn = e.target.closest('.picker-option')
  if (btn?.dataset.lang) {
    i18n.setLocale(btn.dataset.lang)
    langDropdown.classList.remove('open')
  }
})

/* ═══ Theme picker (View Transition circular reveal) ════════════════ */
;(function initTheme() {
  const THEME_KEY = 'rayburst-website-theme'
  const meta = document.querySelector('meta[name="theme-color"]')
  const toggle = document.getElementById('theme-toggle')
  const dropdown = document.getElementById('theme-dropdown')
  const label = document.getElementById('theme-toggle-label')
  const systemHint = document.getElementById('theme-system-hint')
  const colors = { dark: '#1d1b1e', light: '#f2ecf1' }
  const i18nKeys = { system: 'theme.system', light: 'theme.light', dark: 'theme.dark' }

  const getSystemTheme = () => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

  const getStored = () => {
    try {
      const v = localStorage.getItem(THEME_KEY)
      return v === 'light' || v === 'dark' ? v : 'system'
    } catch {
      return 'system'
    }
  }

  function applyTheme(choice) {
    const effective = choice === 'system' ? getSystemTheme() : choice
    document.documentElement.dataset.theme = effective
    if (meta) meta.content = colors[effective]
    try {
      if (choice === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, choice)
    } catch {
      // Apply the theme even when storage is unavailable.
    }

    label.textContent = i18n.t(i18nKeys[choice])
    const sysLabel = i18n.t(i18nKeys[getSystemTheme()])
    systemHint.querySelector('span').textContent = `${i18n.t('theme.system')} (${sysLabel})`
    dropdown.querySelectorAll('.picker-option').forEach((opt) => {
      opt.classList.toggle('active', opt.dataset.theme === choice)
    })
  }

  applyTheme(getStored())
  i18n.onLocaleChange(() => applyTheme(getStored()))

  toggle.addEventListener('click', (e) => {
    e.stopPropagation()
    dropdown.classList.toggle('open')
  })

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && !toggle.contains(e.target)) {
      dropdown.classList.remove('open')
    }
  })

  dropdown.querySelectorAll('.picker-option').forEach((opt) => {
    opt.addEventListener('click', async () => {
      const choice = opt.dataset.theme
      dropdown.classList.remove('open')
      if (opt.classList.contains('active')) return

      if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        applyTheme(choice)
        return
      }

      const rect = toggle.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))

      const transition = document.startViewTransition(() => applyTheme(choice))
      await transition.ready
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 600, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' },
      )
    })
  })

  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getStored() === 'system') applyTheme('system')
  })
})()

/* ═══ Lightbox ══════════════════════════════════════════════════════ */
function openLightbox(source) {
  const image = document.getElementById('lightbox-img')
  image.src = source.src
  image.alt = source.alt
  document.getElementById('lightbox').showModal()
}

function closeLightbox() {
  document.getElementById('lightbox').close()
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('theme-dropdown').classList.remove('open')
    document.getElementById('lang-dropdown').classList.remove('open')
  }
})

/* ═══ Download section ══════════════════════════════════════════════ */
const ICONS = {
  download: '<svg class="ic" width="14" height="14"><use href="#i-download"/></svg>',
  external: '<svg class="ic" width="13" height="13"><use href="#i-external"/></svg>',
}

const PLATFORMS = [
  {
    key: 'dmg-arm',
    os: 'macOS',
    arch: 'Apple Silicon',
    fmt: '.dmg',
    match: (n) => n.includes('aarch64') && n.endsWith('.dmg'),
  },
  { key: 'dmg-x64', os: 'macOS', arch: 'Intel', fmt: '.dmg', match: (n) => n.includes('x64') && n.endsWith('.dmg') },
  {
    key: 'exe-x64',
    os: 'Windows',
    arch: 'x64',
    fmt: '.exe',
    match: (n) => n.includes('x64') && n.endsWith('-setup.exe'),
  },
  {
    key: 'exe-arm',
    os: 'Windows',
    arch: 'ARM64',
    fmt: '.exe',
    match: (n) => /(?:aarch64|arm64)/.test(n) && n.endsWith('-setup.exe'),
  },
  {
    key: 'appimage-x64',
    os: 'Linux',
    arch: 'x64',
    fmt: '.AppImage',
    match: (n) => n.includes('amd64') && n.endsWith('.AppImage'),
  },
  { key: 'deb-x64', os: 'Linux', arch: 'x64', fmt: '.deb', match: (n) => n.includes('amd64') && n.endsWith('.deb') },
  { key: 'rpm-x64', os: 'Linux', arch: 'x64', fmt: '.rpm', match: (n) => n.includes('x86_64') && n.endsWith('.rpm') },
  {
    key: 'appimage-arm',
    os: 'Linux',
    arch: 'ARM64',
    fmt: '.AppImage',
    match: (n) => n.includes('aarch64') && n.endsWith('.AppImage'),
  },
  {
    key: 'deb-arm',
    os: 'Linux',
    arch: 'ARM64',
    fmt: '.deb',
    match: (n) => /(?:aarch64|arm64)/.test(n) && n.endsWith('.deb'),
  },
  {
    key: 'rpm-arm',
    os: 'Linux',
    arch: 'ARM64',
    fmt: '.rpm',
    match: (n) => n.includes('aarch64') && n.endsWith('.rpm'),
  },
]

const ARCH_OPTIONS = {
  macOS: [
    { label: 'Apple Silicon', sub: 'arm64', dlKey: 'dmg-arm' },
    { label: 'Intel', sub: 'x86_64', dlKey: 'dmg-x64' },
  ],
  Windows: [
    { label: 'x64', sub: 'Intel / AMD', dlKey: 'exe-x64' },
    { label: 'ARM64', sub: 'arm64', dlKey: 'exe-arm' },
  ],
  Linux: [
    { label: 'x64', sub: 'amd64', dlKey: 'appimage-x64' },
    { label: 'ARM64', sub: 'aarch64', dlKey: 'appimage-arm' },
  ],
}

const ARCH_HELP_KEYS = {
  macOS: 'dl.modal.help.macOS',
  Windows: 'dl.modal.help.windows',
  Linux: 'dl.modal.help.linux',
}

function detectOS() {
  const ua = navigator.userAgent
  if (ua.includes('Mac')) return 'macOS'
  if (ua.includes('Win')) return 'Windows'
  if (ua.includes('Android') || ua.includes('CrOS')) return null
  if (ua.includes('Linux')) return 'Linux'
  return null
}

const dlModal = document.getElementById('dl-modal')

function openDlModal(os, resolvedUrls, releaseUrl) {
  const options = ARCH_OPTIONS[os]
  if (!options) return

  document.getElementById('dl-modal-title').textContent = i18n.t('dl.modal.title', { os })

  const grid = document.getElementById('dl-modal-options')
  grid.innerHTML = ''

  for (const opt of options) {
    const url = resolvedUrls[opt.dlKey]
    const hasFile = !!url
    const a = document.createElement('a')
    a.href = url || releaseUrl
    a.target = hasFile ? '_self' : '_blank'
    a.rel = 'noopener'
    a.className = 'modal-opt' + (hasFile ? '' : ' modal-opt--ghost')
    a.innerHTML =
      `<span class="modal-opt-label">${opt.label}</span>` +
      `<span class="modal-opt-sub">${opt.sub}</span>` +
      `<span class="modal-opt-action">` +
      (hasFile
        ? `${ICONS.download} ${i18n.t('dl.modal.download')}`
        : `${ICONS.external} ${i18n.t('dl.modal.viewRelease')}`) +
      `</span>`
    if (hasFile) a.addEventListener('click', () => setTimeout(closeDlModal, 300))
    grid.appendChild(a)
  }

  const helpKey = ARCH_HELP_KEYS[os]
  document.getElementById('dl-modal-help').innerHTML =
    i18n.t('dl.modal.notSure') + ' ' + (helpKey ? i18n.t(helpKey) : '')

  dlModal.showModal()
}

function closeDlModal() {
  dlModal.close()
}

/* ═══ Boot ══════════════════════════════════════════════════════════ */
;(async () => {
  await i18n.ready

  const os = detectOS()
  const detected = document.getElementById('dl-detected')
  const primary = document.getElementById('dl-primary')
  const primaryText = document.getElementById('dl-primary-text')
  const toggle = document.getElementById('dl-toggle')
  const allWrap = document.getElementById('dl-all')
  const grid = document.getElementById('dl-grid')

  if (os) detected.textContent = i18n.t('dl.detected', { os })

  let hasPrimaryOS = false
  i18n.onLocaleChange(() => {
    if (os) detected.textContent = i18n.t('dl.detected', { os })
    primaryText.textContent = hasPrimaryOS ? i18n.t('dl.primary', { os }) : i18n.t('dl.primary.fallback')
  })

  toggle.addEventListener('click', () => {
    toggle.classList.toggle('active')
    allWrap.classList.toggle('open')
  })

  let resolvedUrls = {}
  let releaseUrl = 'https://github.com/AnInsomniacy/motrix-next/releases'
  let apiFailed = false
  const verEl = document.getElementById('stat-version')

  /* Repository stars and download counts */
  ;(async () => {
    const starsEl = document.getElementById('stat-stars')
    const dlEl = document.getElementById('stat-downloads')

    const fail = (el) => {
      el.classList.remove('loading')
      el.textContent = '—'
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 8000)

    try {
      const [repoRes, releasesRes] = await Promise.all([
        fetch('https://api.github.com/repos/AnInsomniacy/motrix-next', { signal: controller.signal }),
        fetch('https://api.github.com/repos/AnInsomniacy/motrix-next/releases?per_page=100', {
          signal: controller.signal,
        }),
      ])
      clearTimeout(timeoutId)

      if (repoRes.ok) {
        const repo = await repoRes.json()
        starsEl.classList.remove('loading')
        countUp(starsEl, repo.stargazers_count || 0, compactNumber)
      } else fail(starsEl)

      if (releasesRes.ok) {
        const releases = await releasesRes.json()
        let total = 0
        for (const release of releases) {
          for (const asset of release.assets || []) total += asset.download_count || 0
        }
        dlEl.classList.remove('loading')
        countUp(dlEl, total, compactNumber)
      } else {
        fail(dlEl)
      }
    } catch {
      clearTimeout(timeoutId)
      fail(starsEl)
      fail(dlEl)
    }
  })()

  /* Latest release assets → primary button + all-platforms grid */
  try {
    const res = await fetch('https://api.github.com/repos/AnInsomniacy/motrix-next/releases/latest', {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`Release request failed: ${res.status}`)
    const data = await res.json()
    if (data.draft || data.prerelease || !Array.isArray(data.assets)) {
      throw new Error('Expected a published stable release')
    }
    verEl.classList.remove('loading')
    verEl.textContent = data.tag_name
    const assets = data.assets || []
    releaseUrl = data.html_url || releaseUrl

    for (const p of PLATFORMS) {
      const asset = assets.find((a) => p.match(a.name))
      if (asset) resolvedUrls[p.key] = asset.browser_download_url
    }

    if (os) {
      primaryText.textContent = i18n.t('dl.primary', { os })
      hasPrimaryOS = true
    }

    // Build all-platforms rows grouped by OS (+arch for Linux)
    const groups = []
    let lastGroup = ''
    for (const p of PLATFORMS) {
      const groupKey = p.os === 'Linux' ? `${p.os} · ${p.arch}` : p.os
      if (groupKey !== lastGroup) {
        lastGroup = groupKey
        groups.push({ key: groupKey, os: p.os, items: [p] })
      } else {
        groups[groups.length - 1].items.push(p)
      }
    }

    for (const g of groups) {
      const row = document.createElement('div')
      row.className = 'dl-row'

      const label = document.createElement('span')
      label.className = 'dl-row-label'
      label.textContent = g.key
      row.appendChild(label)

      const pills = document.createElement('div')
      pills.className = 'dl-row-pills'

      for (const p of g.items) {
        const isLinux = p.os === 'Linux'
        const pill = document.createElement('a')
        pill.href = resolvedUrls[p.key] || releaseUrl
        pill.target = '_blank'
        pill.rel = 'noopener'
        pill.className = 'dl-pill'
        const pillLabel = isLinux ? p.fmt : p.arch
        const pillMeta = isLinux ? '' : ` <span class="dl-pill-fmt">${p.fmt}</span>`
        pill.innerHTML = `${ICONS.download} ${pillLabel}${pillMeta}`
        pills.appendChild(pill)
      }

      row.appendChild(pills)
      grid.appendChild(row)
    }
  } catch {
    verEl.classList.remove('loading')
    verEl.textContent = '—'
    apiFailed = true
    primary.href = releaseUrl
    primaryText.textContent = i18n.t('dl.primary.fallback')
  }

  // Intercept download clicks → architecture modal
  function handleDownloadClick(e) {
    if (apiFailed || !os) return // fall through to the releases page
    e.preventDefault()
    openDlModal(os, resolvedUrls, releaseUrl)
  }

  primary.addEventListener('click', handleDownloadClick)
})()
