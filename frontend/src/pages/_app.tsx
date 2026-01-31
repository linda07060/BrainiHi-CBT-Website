import * as React from "react";
import Head from "next/head";
import { ThemeProvider, CssBaseline, Box, Alert } from "@mui/material";
import theme from "../theme";
import { AuthProvider } from "../context/AuthContext";
import type { AppProps } from "next/app";

import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/router";

import CookieConsent from "../components/CookieConsent";
import adminApi from "../lib/adminApi"; // use adminApi to reuse NEXT_PUBLIC_API_URL
import axios from "axios";
import Footer from "../components/Footer";
import StickyNotice from "../components/StickyNotice";
import FooterLegalBar from "../components/FooterLegalBar";

// New site-settings components / provider (added earlier)
import { SiteSettingsProvider, useSiteSettings } from "../components/SiteSettingsProvider";
import SiteAnnouncement from "../components/SiteAnnouncement";
import SiteFooterSupport from "../components/SiteFooterSupport";

const DEFAULT_TITLE = "Prepare for exams faster with AI";

function tryInitAnalyticsFromGlobal() {
  try {
    const win = window as any;
    if (typeof win.initAnalytics === "function") {
      win.initAnalytics();
      return true;
    }
  } catch (err) {
    // ignore
  }
  return false;
}

export default function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();

  // Ensure a sensible default title is present immediately on client mount to avoid flicker.
  // This runs before SiteSettingsProvider fetch completes and before any other client code may change title.
  React.useEffect(() => {
    try {
      const defaultTitle = process.env.NEXT_PUBLIC_DEFAULT_TITLE ?? DEFAULT_TITLE;
      if (typeof document !== "undefined") {
        // Only set if document.title is empty or currently set to a URL/host value
        const current = (document.title ?? "").trim();
        const looksLikeHost = current === "" || current.includes("localhost") || current === window.location.host;
        if (looksLikeHost) {
          document.title = defaultTitle;
        }
      }
    } catch {
      // ignore
    }
  }, []);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem("brainihi_cookie_consent_v1");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.analytics) {
          tryInitAnalyticsFromGlobal();
        }
      }
    } catch (err) {
      // ignore
    }

    const handler = (e: Event) => {
      try {
        const detail = (e as CustomEvent).detail;
        if (detail && detail.analytics) {
          tryInitAnalyticsFromGlobal();
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener("cookie-consent", handler as EventListener);
    return () => {
      window.removeEventListener("cookie-consent", handler as EventListener);
    };
  }, []);

  // Ensure Authorization header is applied to our API client (adminApi) and axios global defaults on client startup.
  // This avoids race conditions where client code calls protected endpoints (e.g. setup-passphrase) before the header is set.
  // This effect is intentionally lightweight and non-blocking: it sets headers if a token is present in localStorage,
  // and also listens for storage events so other tabs update headers.
  React.useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const raw = localStorage.getItem("auth");
      const auth = raw ? JSON.parse(raw) : null;
      const token = auth?.token ?? auth?.access_token ?? auth?.accessToken ?? null;
      if (token) {
        try {
          // Apply to adminApi instance safely
          if ((adminApi as any).defaults && (adminApi as any).defaults.headers) {
            (adminApi.defaults as any).headers = (adminApi.defaults as any).headers || {};
            (adminApi.defaults as any).headers.common = (adminApi.defaults as any).headers.common || {};
            (adminApi.defaults as any).headers.common['Authorization'] = `Bearer ${token}`;
          } else {
            // best-effort fallback
            try { (adminApi.defaults.headers as any).common['Authorization'] = `Bearer ${token}`; } catch {}
          }
        } catch {
          // ignore
        }

        try {
          (axios as any).defaults = (axios as any).defaults || {};
          (axios as any).defaults.headers = (axios as any).defaults.headers || {};
          (axios as any).defaults.headers.common = (axios as any).defaults.headers.common || {};
          (axios as any).defaults.headers.common['Authorization'] = `Bearer ${token}`;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore parse errors
    }

    // Listen for storage events so other tabs/windows updating auth reflect immediately.
    const onStorage = (e: StorageEvent) => {
      try {
        if (e.key !== 'auth') return;
        const newAuth = e.newValue ? JSON.parse(e.newValue) : null;
        const newToken = newAuth?.token ?? newAuth?.access_token ?? newAuth?.accessToken ?? null;
        if (newToken) {
          try {
            (adminApi.defaults.headers as any).common['Authorization'] = `Bearer ${newToken}`;
          } catch {
            try { (adminApi.defaults as any).headers.common['Authorization'] = `Bearer ${newToken}`; } catch {}
          }
          try { (axios as any).defaults.headers.common['Authorization'] = `Bearer ${newToken}`; } catch {}
        } else {
          // removed / logged out
          try { delete (adminApi.defaults.headers as any).common['Authorization']; } catch {}
          try { delete (axios as any).defaults.headers.common['Authorization']; } catch {}
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Global axios/adminApi response interceptor for soft-limit warnings is harmless and kept,
  // but we avoid doing any global redirect or heavy work here to prevent races with page-level flows.
  React.useEffect(() => {
    const id = (adminApi as any).interceptors.response.use(
      (resp: any) => {
        try {
          const data = (resp?.data ?? {}) as { warning?: string | null };
          const warning = data.warning;
          if (warning) {
            window.dispatchEvent(new CustomEvent("soft-limit-warning", { detail: warning }));
          }
        } catch (err) {
          // ignore
        }
        return resp;
      },
      (error: any) => {
        return Promise.reject(error);
      }
    );

    return () => {
      try { (adminApi as any).interceptors.response.eject(id); } catch {}
    };
  }, []);

  // Small listener so the app-level code knows when adminApi reports unauthorized
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onUnauthorized = (e: any) => {
      // Log once; components that care should read window.__adminApiUnauthorized or listen to this event
      console.warn('Global: adminApi reported Unauthorized (401). Components should stop admin polling.');
    };
    const onAuthorized = (e: any) => {
      console.debug('Global: adminApi authorized again.');
    };
    window.addEventListener('adminApi:unauthorized', onUnauthorized as EventListener);
    window.addEventListener('adminApi:authorized', onAuthorized as EventListener);
    return () => {
      window.removeEventListener('adminApi:unauthorized', onUnauthorized as EventListener);
      window.removeEventListener('adminApi:authorized', onAuthorized as EventListener);
    };
  }, []);

  // INSTALL GLOBAL AXIOS INTERCEPTOR: detect server-side enforcement 403 responses and redirect to setup pages.
  // This effect is intentionally lightweight and client-only. It only reacts to 403 responses that include
  // require flags or a message implying setup is required, and will not affect other status codes.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const id = axios.interceptors.response.use(
      (resp) => resp,
      (error: any) => {
        try {
          const status = error?.response?.status;
          const data = error?.response?.data ?? {};
          if (status === 403) {
            const needSec =
              !!(data?.requireSecuritySetup ?? data?.require_security_setup ?? data?.requireSecurity ?? data?.require_security);
            const needPass =
              !!(data?.requirePassphraseSetup ?? data?.require_passphrase_setup ?? data?.requirePassphrase ?? data?.require_passphrase);

            if (needSec && needPass) {
              router.replace("/setup-required");
              return Promise.reject(error);
            }
            if (needSec) {
              router.replace("/setup-security");
              return Promise.reject(error);
            }
            if (needPass) {
              router.replace("/setup-passphrase");
              return Promise.reject(error);
            }

            // Fallback: if message implies setup is required, redirect to the combined page
            const msg = String(data?.message ?? "").toLowerCase();
            if (msg.includes("require") && msg.includes("setup")) {
              router.replace("/setup-required");
              return Promise.reject(error);
            }
          }
        } catch (e) {
          // ignore errors in interceptor
        }
        return Promise.reject(error);
      }
    );

    return () => {
      try { axios.interceptors.response.eject(id); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Hide footer on specific routes
  const NO_FOOTER_PREFIXES = [
    "/login",
    "/register",
    "/dashboard",
    "/analytics",
    "/ai-tutor",
    "/test",
    "/review",
    "/admin/login",
    "/checkout",
  ];
  const showFooter = !NO_FOOTER_PREFIXES.some((p) => router.pathname.startsWith(p));

  const NO_NOTICE_PREFIXES = ["/login", "/register"];
  const showStickyNotice = !NO_NOTICE_PREFIXES.some((p) => router.pathname.startsWith(p));

  const poweredText =
    "Powered by OpenAI — our platform uses OpenAI technologies to generate questions, explanations, and performance analysis. OpenAI provides the underlying models; BrainiHi configures prompts, validation and quality controls to produce safe, educational content.";

  // We wrap the app with SiteSettingsProvider so the whole app can read admin-managed settings.
  // Use an inner component so hooks (useSiteSettings) can be used after the provider is mounted.
  function AppContent() {
    const { settings } = useSiteSettings();

    // Keep backward-compatible behavior: if siteTitle is set in settings, use it in document title.
    // Guard against empty strings or values containing hostnames (e.g. "localhost") to avoid blanking or fallback-to-host.
    React.useEffect(() => {
      try {
        const candidate = settings?.siteTitle;
        if (typeof candidate === "string" && candidate.trim()) {
          // Avoid using values that look like a host/URL as the title
          const lower = candidate.toLowerCase();
          const host = (window?.location?.hostname ?? "").toLowerCase();
          if (!lower.includes("localhost") && !lower.includes(host)) {
            document.title = candidate.trim();
            return;
          }
        }
        // fallback to default when no valid candidate
        document.title = process.env.NEXT_PUBLIC_DEFAULT_TITLE ?? DEFAULT_TITLE;
      } catch {
        // ignore
      }
    }, [settings?.siteTitle]);

    // Maintenance banner values
    const maintenanceEnabled = !!settings?.maintenance?.enabled;
    const maintenanceMessage = settings?.maintenance?.message ?? "Site is under maintenance. Please check back later.";

    // Memoize the rendered page element so it is not re-created on unrelated AppContent re-renders.
    // This prevents unnecessary remounts of modal children and stops the "blink" without changing logic.
    const MemoizedPage = React.useMemo(() => <Component {...pageProps} />, [router.route, JSON.stringify(pageProps)]);

    return (
      <>
        <Head>
          {/* Keep a server-rendered/default title here so initial HTML title is stable and doesn't flash */}
          <title>{settings?.siteTitle && String(settings.siteTitle).trim() ? settings.siteTitle : (process.env.NEXT_PUBLIC_DEFAULT_TITLE ?? DEFAULT_TITLE)}</title>
          <meta
            name="description"
            content="Practice smarter, get instant explanations, and improve your scores with BrainiHi — AI-powered exam preparation."
          />
        </Head>

        {/* Announcement banner (component handles its own visibility and close) */}
        {/* Do not show announcement on admin pages */}
        {!router.pathname.startsWith("/admin") && <SiteAnnouncement />}

        {/* Maintenance banner - visible on public pages (admin routes still accessible) */}
        {maintenanceEnabled && !router.pathname.startsWith("/admin") && (
          <Box sx={{ width: "100%", position: "sticky", top: 0, zIndex: 1400 }}>
            <Alert severity="warning" sx={{ borderRadius: 0 }}>
              {maintenanceMessage}
            </Alert>
          </Box>
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={router.route}
            // Prevent re-running the initial entry animation on re-renders (already set)
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -32 }}
            transition={{ duration: 0.45, ease: [0.39, 0.58, 0.57, 1] }}
            style={{ minHeight: "100vh" }}
          >
            {MemoizedPage}
          </motion.div>
        </AnimatePresence>

        <CookieConsent />

        {showStickyNotice && (
          <StickyNotice
            text={poweredText}
            storageKey="powered_notice_v1"
            persistMinutes={null}
            hideOnRoutes={NO_NOTICE_PREFIXES}
            onDismiss={() => {
              try {
                (window as any).dataLayer?.push?.({ event: "sticky_notice_dismissed", notice: "powered_by_openai" });
              } catch {}
            }}
          />
        )}

        <FooterLegalBar />

        {/* Footer support info uses settings from SiteSettingsProvider */}
        {showFooter && (
          <>
            <SiteFooterSupport />
            <Footer />
          </>
        )}
      </>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AuthProvider>
        <SiteSettingsProvider>
          {/* Provide a server/client default <Head> so initial HTML title is stable and doesn't flash */}
          <Head>
            <title>{process.env.NEXT_PUBLIC_DEFAULT_TITLE ?? DEFAULT_TITLE}</title>
          </Head>

          <AppContent />
        </SiteSettingsProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}