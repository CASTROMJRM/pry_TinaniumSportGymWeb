// Lighthouse revisa la compilación de producción servida localmente.
// NO evalúa el despliegue de Vercel ni comprueba la API real.
// Instalación, cachés y modo offline se verifican mediante Playwright.
module.exports = {
  ci: {
    collect: {
      startServerCommand: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
      startServerReadyPattern: 'Local:',
      startServerReadyTimeout: 30000,
      url: [
        'http://127.0.0.1:4173/',
        'http://127.0.0.1:4173/about',
      ],
      numberOfRuns: 1,
      settings: {
        chromeFlags: '--no-sandbox --disable-dev-shm-usage',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        maxWaitForLoad: 45000,
      },
    },
    assert: {
      // Umbrales de advertencia: no se inventa una calificación ni se oculta una puntuación baja.
      assertions: {
        'categories:performance': ['warn', { minScore: 0.5 }],
        'categories:accessibility': ['warn', { minScore: 0.7 }],
        'categories:best-practices': ['warn', { minScore: 0.7 }],
        'categories:seo': ['warn', { minScore: 0.7 }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: './lighthouse-reports',
    },
  },
};
