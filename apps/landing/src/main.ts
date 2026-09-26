/**
 * Landing page bootstrap.
 *
 * On the deployed domain the demo links are absolute sub-paths (/react/,
 * /nuxt/) served through the landing project's rewrites. When running the
 * workspace locally (each app on its own dev port), rewrite the CTAs to
 * the local dev servers instead so the page stays fully functional.
 */

const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)

const LOCAL_TARGETS: Record<string, string> = {
  '/react/': 'http://127.0.0.1:5174/react/',
  '/nuxt/': 'http://127.0.0.1:3001/nuxt/',
}

if (isLocal) {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="/react"], a[href^="/nuxt"]')) {
    const target = LOCAL_TARGETS[a.getAttribute('href') ?? '']
    if (target) {
      // preserve query strings (e.g. ?feed=synthetic&rate=1000)
      const query = a.search
      a.href = target + (query ? query : '')
    }
  }
}

document.querySelector('#year')?.append(String(new Date().getFullYear()))
