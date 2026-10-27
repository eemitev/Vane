import type { MetadataRoute } from 'next';

/**
 * Web app manifest, so Vane installs to the home screen as an app rather than
 * a bookmark.
 *
 * Deliberately no service worker. One is only needed for offline caching, and
 * every answer here comes from the server -- there is nothing useful to serve
 * offline. Adding one would buy nothing and introduce the familiar failure
 * where an installed app runs stale JavaScript for days after a deploy. Without
 * it, every launch loads what is currently deployed.
 *
 * This file is also the prerequisite for a Trusted Web Activity later: an APK
 * is generated from exactly this manifest.
 */
const manifest = (): MetadataRoute.Manifest => ({
  name: 'Vane',
  short_name: 'Vane',
  description: 'Research begins here.',
  /* Launching at the root rather than a saved path: a research run is tied to
   * a session, so resuming an old chat on launch would usually be wrong. */
  start_url: '/',
  scope: '/',
  /* standalone, not fullscreen: the status bar stays, which matters on a phone
   * where you want the clock and battery while a long run finishes. */
  display: 'standalone',
  orientation: 'portrait-primary',
  background_color: '#0f1419',
  theme_color: '#0f1419',
  categories: ['productivity', 'utilities'],
  icons: [
    {
      src: '/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
    {
      /* Android crops icons to a circle or squircle. The art inside this one
       * is inset so the crop takes padding rather than the logo. */
      src: '/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
});

export default manifest;
