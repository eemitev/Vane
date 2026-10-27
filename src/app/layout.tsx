export const dynamic = 'force-dynamic';

import type { Metadata, Viewport } from 'next';
import { Montserrat } from 'next/font/google';
import './globals.css';
import { cn } from '@/lib/utils';
import Sidebar from '@/components/Sidebar';
import { Toaster } from 'sonner';
import ThemeProvider from '@/components/theme/Provider';
import configManager from '@/lib/config';
import SetupWizard from '@/components/Setup/SetupWizard';
import { ChatProvider } from '@/lib/hooks/useChat';

const montserrat = Montserrat({
  weight: ['300', '400', '500', '700'],
  subsets: ['latin'],
  display: 'swap',
  fallback: ['Arial', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'Vane - Direct your curiosity',
  description: 'Vane is an AI powered answering engine.',
  /* Installed-app behaviour on iOS, which ignores the web manifest. Android
   * reads app/manifest.ts instead. */
  appleWebApp: {
    capable: true,
    title: 'Vane',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  /* Matches the manifest's theme_color so the system bars blend with the app
   * rather than framing it in white. */
  themeColor: '#0f1419',
  /* viewportFit cover lets the layout reach under the gesture bar and the
   * punch-hole area on a tall phone; the app already handles its own padding. */
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
  /* Zoom stays available: pinch-to-zoom is an accessibility affordance, and
   * disabling it is a habit worth not copying. */
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const setupComplete = configManager.isSetupComplete();
  const configSections = configManager.getUIConfigSections();

  return (
    <html className="h-full" lang="en" suppressHydrationWarning>
      <body className={cn('h-full antialiased', montserrat.className)}>
        <ThemeProvider>
          {setupComplete ? (
            <ChatProvider>
              <Sidebar>{children}</Sidebar>
              <Toaster
                toastOptions={{
                  unstyled: true,
                  classNames: {
                    toast:
                      'bg-light-secondary dark:bg-dark-secondary dark:text-white/70 text-black-70 rounded-lg p-4 flex flex-row items-center space-x-2',
                  },
                }}
              />
            </ChatProvider>
          ) : (
            <SetupWizard configSections={configSections} />
          )}
        </ThemeProvider>
      </body>
    </html>
  );
}
