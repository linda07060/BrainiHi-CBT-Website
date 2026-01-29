import React, { useEffect, useRef, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import {
  Box,
  Container,
  Typography,
  CircularProgress,
  Alert,
  Button,
  Stack,
  Link as MuiLink,
} from "@mui/material";
import Header from "../components/Header";
import api from "../lib/api";

/* ---- Response shapes ---- */
interface AttachOrderResponse {
  payment?: any;
  paymentId?: number | string;
  [k: string]: any;
}
type CreateOrderResponse = { orderID?: string; orderId?: string; id?: string; payment?: any; paymentId?: number | string; [k: string]: any };
type CaptureResponse = { id?: number | string; paymentId?: number | string; [k: string]: any };
type CreatePendingResponse = { payment?: any; paymentId?: number | string } | null;

declare global {
  interface Window {
    paypal?: any;
  }
}

/* ---------- Small local helpers ---------- */
function getLocalAuthTokenFromStorage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("auth");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.token ?? null;
  } catch {
    return null;
  }
}

/* ---------- Small local price helper (same mapping used on subscription/practice) ---------- */
function mapPlanPrice(plan?: string | null, billingPeriod?: string | null) {
  const p = (plan || "Pro").toString().toLowerCase();
  const bp = (billingPeriod || "monthly").toString().toLowerCase();
  if (p.includes("pro")) {
    if (bp.includes("year")) return { amount: "99.00", currency: "USD" };
    return { amount: "12.99", currency: "USD" };
  }
  if (p.includes("tutor")) {
    if (bp.includes("year")) return { amount: "199.00", currency: "USD" };
    return { amount: "24.99", currency: "USD" };
  }
  return { amount: "0.00", currency: "USD" };
}

/* ---------- Utilities ---------- */
function formatError(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  try {
    const anyErr = err as any;
    if (anyErr?.message && typeof anyErr.message === "string") return anyErr.message;
  } catch {}
  try {
    return JSON.stringify(err, Object.getOwnPropertyNames(err));
  } catch {
    try {
      return String(err);
    } catch {
      return "Unknown error";
    }
  }
}

/* ---------- localStorage helpers for posting invoice to account page when opener missing ---------- */
const INVOICES_CACHE_KEY = "cached_invoices_v1";
function cacheInvoiceLocally(serverPayment: any) {
  try {
    const cachedRaw = localStorage.getItem(INVOICES_CACHE_KEY);
    const parsed = cachedRaw ? JSON.parse(cachedRaw) : [];
    const key = String(serverPayment.id ?? `inv-${Math.random().toString(36).slice(2, 9)}`);
    const norm = {
      id: key,
      plan: serverPayment.plan ?? serverPayment.plan_name ?? "Unknown",
      amount: String(serverPayment.amount ?? serverPayment.total ?? "0.00"),
      currency: serverPayment.currency ?? "USD",
      issuedAt: serverPayment.date
        ? new Date(serverPayment.date).toISOString()
        : serverPayment.createdAt
        ? new Date(serverPayment.createdAt).toISOString()
        : new Date().toISOString(),
      status: String(serverPayment.status ?? "pending").toLowerCase(),
      receipt_url: serverPayment.receipt_url ?? `/receipt/${key}`,
      reason: serverPayment.reason ?? serverPayment.__meta?.reason ?? null,
      change_to: serverPayment.change_to ?? serverPayment.__meta?.change_to ?? null,
    };
    const merged = [norm, ...(Array.isArray(parsed) ? parsed : [])].filter(Boolean);
    const seen = new Set<string>();
    const dedup = merged.filter((m: any) => {
      const k = String(m.id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    localStorage.setItem(INVOICES_CACHE_KEY, JSON.stringify(dedup));
  } catch (e) {
    // noop
  }
}

/* ---------- SDK loader helper ---------- */
async function loadPayPalSdk(sdkSrc: string, timeoutMs = 15000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const existing = Array.from(document.querySelectorAll('script[src^="https://www.paypal.com/sdk/js"], script[src^="https://www.sandbox.paypal.com/sdk/js"]')) as HTMLScriptElement[];

      for (const s of existing) {
        if (s.src && s.src !== sdkSrc) {
          try { s.remove(); } catch {}
        }
      }

      const already = Array.from(document.querySelectorAll(`script[src="${sdkSrc}"]`)).shift() as HTMLScriptElement | undefined;

      const finalize = () => {
        const start = Date.now();
        const int = setInterval(() => {
          if ((window as any).paypal) {
            clearInterval(int);
            resolve();
            return;
          }
          if (Date.now() - start > timeoutMs) {
            clearInterval(int);
            reject(new Error("PayPal SDK did not initialize within timeout"));
          }
        }, 200);
      };

      if (already) {
        finalize();
        return;
      }

      const s = document.createElement("script");
      s.src = sdkSrc;
      s.async = true;
      s.onload = () => {
        finalize();
      };
      s.onerror = () => reject(new Error("Failed to load PayPal SDK script"));
      document.body.appendChild(s);
    } catch (err) {
      reject(err);
    }
  });
}

/** Complete Checkout Page Logic (card funding enabled) */
export default function CheckoutPage(): JSX.Element {
  const router = useRouter();
  const { plan, billingPeriod, amount: amountQuery, invoiceId } = router.query as {
    plan?: string;
    billingPeriod?: string;
    amount?: string;
    invoiceId?: string;
  };

  const apiBase = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || "";

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orderID, setOrderID] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [creating, setCreating] = useState(false);

  // Use ref for pendingPayment so we don't reinitialize SDK when it changes
  const pendingPaymentRef = useRef<any | null>(null);
  const [pendingPaymentState, setPendingPaymentState] = useState<any | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const computedPrice = (() => {
    if (typeof amountQuery === "string" && amountQuery.trim() !== "") {
      const parts = amountQuery.trim().split(/\s+/);
      const amount = parts[0];
      const currency = parts[1] ?? "USD";
      return { amount: String(amount), currency: String(currency) };
    }
    return mapPlanPrice(plan ?? undefined, billingPeriod ?? undefined);
  })();

  // Hide footer on this page
  useEffect(() => {
    if (typeof document === "undefined") return;
    const footer = document.querySelector("footer");
    if (!footer) return;
    const prevDisplay = (footer as HTMLElement).style.display;
    try {
      (footer as HTMLElement).style.display = "none";
    } catch {}
    return () => {
      try {
        (footer as HTMLElement).style.display = prevDisplay || "";
      } catch {}
    };
  }, []);

  // Create pending invoice on server ASAP (store in ref to avoid re-triggering SDK)
  async function createPendingPaymentOnServer(): Promise<CreatePendingResponse> {
    try {
      const url = "/api/payments/create-pending";
      const payload: any = { plan: plan ?? "Pro", billingPeriod: billingPeriod ?? "monthly", amount: computedPrice.amount };
      const token = getLocalAuthTokenFromStorage();
      const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
      const res = await api.post<CreatePendingResponse>(url, payload, opts);
      const data = res?.data ?? null;
      if (data) {
        // set ref first
        pendingPaymentRef.current = data?.payment ?? data;
        setPendingPaymentState(data?.payment ?? data);
        try {
          if (window.opener) {
            window.opener.postMessage({ type: "payment:created", payment: data?.payment ?? data }, window.location.origin ?? "*");
          } else {
            cacheInvoiceLocally(data?.payment ?? data);
          }
        } catch {
          cacheInvoiceLocally(data?.payment ?? data);
        }
      }
      return data;
    } catch (err) {
      console.warn("createPendingPaymentOnServer failed", formatError(err));
      return null;
    }
  }

  useEffect(() => {
    createPendingPaymentOnServer().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Helper to call backend create-order endpoint (used as fallback)
  async function serverCreateOrder(): Promise<CreateOrderResponse> {
    const url = "/api/payments/create-order";
    const payload: any = { plan: plan ?? "Pro", billingPeriod: billingPeriod ?? "monthly" };
    if (amountQuery) payload.amount = computedPrice.amount;
    if (invoiceId) payload.invoiceId = invoiceId;
    const token = getLocalAuthTokenFromStorage();
    const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
    const res = await api.post<CreateOrderResponse>(url, payload, opts);
    return res.data;
  }

  // Polling helper: poll /api/payments/invoices until the invoice id appears (or timeout)
  async function pollInvoicesForId(id: string | number, opts?: any, attempts = 15, delayMs = 2000) {
    if (!id) return null;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await api.get("/api/payments/invoices", opts);
        const list = res?.data ?? [];
        if (Array.isArray(list)) {
          try { localStorage.setItem(INVOICES_CACHE_KEY, JSON.stringify(list)); } catch {}
          const found = list.find((it: any) => String(it?.id) === String(id));
          if (found) {
            // notify listeners with authoritative invoice
            try { window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: found } })); } catch {}
            try { if (window.opener) window.opener.postMessage({ type: "payment:created", payment: found }, window.location.origin ?? "*"); } catch {}
            return found;
          }
        }
      } catch (e) {
        // ignore fetch errors and retry
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return null;
  }

  // Helper to retry capture (replay) to force server to update/associate row
  async function retryCapture(orderID: string, opts?: any) {
    try {
      const res = await api.post("/api/payments/capture", { orderID }, opts);
      return res?.data ?? null;
    } catch (e) {
      // swallow
      return null;
    }
  }

  useEffect(() => {
    if (!plan || !billingPeriod) {
      setError("Missing plan or billing period. Please select a plan from your account.");
      setLoading(false);
      return;
    }

    if (!clientId) {
      setError("PayPal client id missing. Set NEXT_PUBLIC_PAYPAL_CLIENT_ID in your frontend .env and restart the server.");
      setLoading(false);
      return;
    }

    // IMPORTANT: to allow users to pay with debit/credit cards (guest checkout)
    // - do NOT disable card funding. Use enable-funding=card,credit in SDK URL.
    // - the merchant PayPal account must allow guest card checkout (PayPal account setting).
    const sdkSrc = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(
      computedPrice.currency ?? "USD"
    )}&intent=capture&commit=true&enable-funding=card,credit`;

    // DEBUG: show which client id and sdk url are used in browser console
    try {
      // eslint-disable-next-line no-console
      console.debug("[checkout] using PayPal clientId:", clientId, "sdkSrc:", sdkSrc);
    } catch {}

    let mounted = true;

    async function renderButtons(): Promise<void> {
      if (!mounted) return;
      try {
        await loadPayPalSdk(sdkSrc, 15000);
      } catch (err) {
        console.error("[checkout] loadPayPalSdk failed:", formatError(err));
        setError("PayPal SDK not available. " + formatError(err));
        setLoading(false);
        return;
      }

      if (!mounted) return;
      if (!window.paypal) {
        setError("PayPal SDK not available.");
        setLoading(false);
        return;
      }

      if (!containerRef.current) {
        setError("Checkout container unavailable.");
        setLoading(false);
        return;
      }

      containerRef.current.innerHTML = "";

      try {
        // Allow rendering card/credit buttons explicitly as well (if supported for the merchant)
        const allowedFunding = [window.paypal.FUNDING.CARD, window.paypal.FUNDING.CREDIT].filter(Boolean);

        window.paypal.Buttons({
          funding: { allowed: allowedFunding },
          createOrder: async (data: any, actions: any) => {
            // Try client-side creation first
            if (actions && typeof actions.order?.create === "function") {
              try {
                setCreating(true);

                const invoiceIdToUse = pendingPaymentRef.current?.id ? String(pendingPaymentRef.current.id) : undefined;
                const createPayload: any = {
                  purchase_units: [
                    {
                      amount: { value: String(computedPrice.amount), currency_code: String(computedPrice.currency ?? "USD") },
                      description: `BrainiHi subscription — ${plan} (${billingPeriod ?? "one-off"})`,
                      ...(invoiceIdToUse ? { invoice_id: invoiceIdToUse } : {}),
                    },
                  ],
                };

                const clientOrderId = await actions.order.create(createPayload);
                setOrderID(String(clientOrderId));

                // Attach order to pending payment server-side (authenticated preferred)
                if (pendingPaymentRef.current?.id) {
                  try {
                    const token = getLocalAuthTokenFromStorage();
                    const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
                    const attachUrl = "/api/payments/attach-order";
                    const attachRes = await api.post<AttachOrderResponse>(
                      attachUrl,
                      { paymentId: pendingPaymentRef.current.id, orderID: clientOrderId },
                      opts,
                    );

                    // If server returned shaped invoice, update ref/state and notify other pages
                    const serverPayment = attachRes?.data?.payment ?? null;
                    if (serverPayment) {
                      pendingPaymentRef.current = serverPayment;
                      setPendingPaymentState(serverPayment);

                      // Save to localStorage for subscription page fallback and dispatch event
                      try {
                        localStorage.setItem("last_created_payment", JSON.stringify(serverPayment));
                      } catch {}
                      try {
                        window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: serverPayment } }));
                      } catch {}
                      try {
                        if (window.opener) window.opener.postMessage({ type: "payment:created", payment: serverPayment }, window.location.origin ?? "*");
                        else cacheInvoiceLocally(serverPayment);
                      } catch {
                        cacheInvoiceLocally(serverPayment);
                      }
                    }
                  } catch (attachErr) {
                    // If authenticated attach fails (401/403/other), attempt public attach fallback
                    console.warn("attach-order failed (auth), attempting public attach:", formatError(attachErr));
                    try {
                      const publicUrl = "/api/payments/attach-order-public";
                      const pubRes = await api.post<AttachOrderResponse>(publicUrl, { orderID: clientOrderId });
                      const pubPayment = pubRes?.data?.payment ?? null;
                      if (pubPayment) {
                        pendingPaymentRef.current = pubPayment;
                        setPendingPaymentState(pubPayment);
                        try {
                          localStorage.setItem("last_created_payment", JSON.stringify(pubPayment));
                        } catch {}
                        try {
                          window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: pubPayment } }));
                        } catch {}
                        try {
                          if (window.opener) window.opener.postMessage({ type: "payment:created", payment: pubPayment }, window.location.origin ?? "*");
                          else cacheInvoiceLocally(pubPayment);
                        } catch {
                          cacheInvoiceLocally(pubPayment);
                        }
                      }
                    } catch (pubErr) {
                      console.warn("public attach failed", formatError(pubErr));
                    }
                  }
                }

                return clientOrderId;
              } catch (clientErr) {
                console.warn("[checkout] actions.order.create failed, falling back to serverCreateOrder:", formatError(clientErr));
              } finally {
                setCreating(false);
              }
            }

            // Fallback to server-created order
            setCreating(true);
            try {
              const created = await serverCreateOrder();
              const id = created?.orderID ?? created?.orderId ?? created?.id ?? null;
              if (!id) throw new Error("Payment server did not return an order id");
              setOrderID(String(id));
              const serverPayment = (created as any)?.payment ?? null;
              if (serverPayment) {
                try {
                  localStorage.setItem("last_created_payment", JSON.stringify(serverPayment));
                } catch {}
                try {
                  window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: serverPayment } }));
                } catch {}
                try {
                  if (window.opener) window.opener.postMessage({ type: "payment:created", payment: serverPayment }, window.location.origin ?? "*");
                  else cacheInvoiceLocally(serverPayment);
                } catch {
                  cacheInvoiceLocally(serverPayment);
                }
              }
              return id;
            } catch (err) {
              console.error("[checkout] createOrder fallback failed:", formatError(err));
              throw err;
            } finally {
              setCreating(false);
            }
          },

          // UPDATED onApprove: normalize server response, cache & dispatch events, then redirect to receipt
          onApprove: async (data: any) => {
            setProcessing(true);
            setError(null);
            try {
              const token = getLocalAuthTokenFromStorage();
              const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
              const url = "/api/payments/capture";
              const res = await api.post<CaptureResponse>(url, { orderID: data.orderID }, opts);
              const payment = res?.data ?? {};

              // Normalize response: controller now returns invoice-shaped object, but be defensive.
              const saved =
                payment && typeof payment === "object"
                  ? (payment.payment ?? payment) // accept either wrapped { payment: ... } or direct shape
                  : payment;

              // If server returned a normalized invoice shape, persist & notify other pages immediately.
              try {
                if (saved && Object.keys(saved).length > 0) {
                  // Persist fallback keys used by subscription page
                  try {
                    localStorage.setItem("last_created_payment", JSON.stringify(saved));
                  } catch {}
                  try {
                    // Also merge into cached invoices list used by subscription page
                    const existingRaw = localStorage.getItem(INVOICES_CACHE_KEY);
                    const existing = existingRaw ? JSON.parse(existingRaw) : [];
                    const normalizedForCache = {
                      id: saved.id ?? `inv-${Math.random().toString(36).slice(2, 9)}`,
                      plan: saved.plan ?? "Unknown",
                      amount: String(saved.amount ?? "0.00"),
                      currency: saved.currency ?? "USD",
                      issuedAt: saved.date ?? new Date().toISOString(),
                      status: String(saved.status ?? "pending").toLowerCase(),
                      receipt_url: saved.receipt_url ?? `/receipt/${saved.id ?? ""}`,
                      reason: saved.reason ?? null,
                      change_to: saved.change_to ?? null,
                    };
                    const merged = [normalizedForCache, ...(Array.isArray(existing) ? existing : [])];
                    // dedupe by id
                    const seen = new Set<string>();
                    const dedup = merged.filter((m: any) => {
                      const k = String(m.id);
                      if (seen.has(k)) return false;
                      seen.add(k);
                      return true;
                    });
                    localStorage.setItem(INVOICES_CACHE_KEY, JSON.stringify(dedup));
                  } catch {}

                  // Dispatch events for opener/subscription page
                  try {
                    window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: saved } }));
                  } catch {}
                  try {
                    if (window.opener) {
                      window.opener.postMessage({ type: "payment:created", payment: saved }, window.location.origin ?? "*");
                    }
                  } catch {}
                }
              } catch (cacheErr) {
                // ignore caching errors
              }

              // Start polling the server invoices endpoint to pick up the authoritative invoice row
              const id = (saved as any)?.id ?? (saved as any)?.paymentId ?? null;
              if (token && id) {
                const found = await pollInvoicesForId(id, opts, 15, 2000);
                if (!found) {
                  // If not found after polling, try up to 2 replay captures and poll again
                  for (let attempt = 0; attempt < 2 && !found; attempt++) {
                    console.warn(`[checkout] authoritative invoice not found after poll; retrying capture attempt=${attempt + 1}`);
                    try {
                      await retryCapture(data.orderID, opts);
                    } catch {}
                    const foundRetry = await pollInvoicesForId(id, opts, 10, 2000);
                    if (foundRetry) break;
                  }
                }
              }

              if (!id) {
                setError("Payment succeeded but server did not return a receipt id.");
                return;
              }
              await router.push(`/receipt/${encodeURIComponent(String(id))}`);
            } catch (err: any) {
              console.error("[checkout] capture failed:", formatError(err));
              setError(err?.response?.data?.message ?? formatError(err) ?? "Capture failed. Please retry.");
            } finally {
              setProcessing(false);
            }
          },

          onCancel: () => {
            setError("Payment cancelled. You can retry.");
          },

          onError: (err: any) => {
            console.error("[checkout] PayPal SDK onError:", err);
            setError("PayPal SDK error: " + formatError(err));
          },
        }).render(containerRef.current);
      } catch (err) {
        console.error("[checkout] error rendering PayPal Buttons:", formatError(err));
        setError("Failed to render PayPal buttons. " + formatError(err));
      } finally {
        setLoading(false);
      }
    }

    renderButtons();

    return () => {
      mounted = false;
    };
    // intentionally NOT including pendingPaymentRef/pendingPaymentState to avoid reinitialising the SDK mid-flow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, clientId, plan, billingPeriod, invoiceId, computedPrice.currency]);

  // Redirect handlers and utilities
  function handleReturnToAccount() {
    router.push("/subscription");
  }

  function copyEnvSample() {
    const sample = "NEXT_PUBLIC_PAYPAL_CLIENT_ID=Your_PayPal_CLIENT_ID_here";
    try {
      navigator.clipboard.writeText(sample);
      alert(".env sample copied to clipboard.");
    } catch {
      alert(`Please add this in your .env file:\n\n${sample}`);
    }
  }

  // Render Checkout Page
  return (
    <>
      <Head>
        <title>Checkout — BrainiHi</title>
      </Head>

      <Header />

      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Box sx={{ p: 3, borderRadius: 2, boxShadow: 1, bgcolor: "background.paper" }}>
          <Typography variant="h5" sx={{ mb: 2 }}>
            Complete payment
          </Typography>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            You are purchasing <strong>{String(plan ?? "")}</strong> — {String(billingPeriod ?? "")}.
          </Typography>

          <Typography variant="subtitle1" sx={{ mb: 3 }}>
            Amount: <strong>{computedPrice.amount} {computedPrice.currency}</strong>
          </Typography>

          {/* Always render the container so the SDK can mount into it when ready */}
          <div ref={containerRef} />

          {loading && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
              <CircularProgress />
            </Box>
          )}

          {!loading && error && (
            <Stack spacing={2} sx={{ mb: 2 }}>
              <Alert severity="error">{error}</Alert>

              {!clientId && (
                <Box sx={{ display: "flex", gap: 2 }}>
                  <Button variant="contained" color="primary" onClick={copyEnvSample}>
                    Copy .env sample
                  </Button>
                  <Button variant="outlined" onClick={handleReturnToAccount}>
                    Return to account
                  </Button>
                </Box>
              )}

              {clientId && (
                <Box sx={{ display: "flex", gap: 2 }}>
                  <Button
                    variant="contained"
                    color="primary"
                    onClick={() => {
                      setError(null);
                      setLoading(true);
                      setTimeout(() => setLoading(false), 250);
                    }}
                    disabled={creating}
                  >
                    {creating ? "Retrying…" : "Retry payment"}
                  </Button>
                  <Button variant="outlined" onClick={handleReturnToAccount}>
                    Return to account
                  </Button>
                </Box>
              )}
            </Stack>
          )}

          {!loading && !error && (
            <>
              {processing && (
                <Typography variant="body2" sx={{ mt: 2 }}>
                  Processing payment…
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
                Payments are processed securely via PayPal.
              </Typography>
              <Box sx={{ mt: 3 }}>
                <Button variant="outlined" onClick={handleReturnToAccount} disabled={processing}>
                  Return to account
                </Button>
              </Box>
            </>
          )}

          <Box sx={{ mt: 3 }}>
            <Typography variant="caption" color="text.secondary">
              Need help? Contact{" "}
              <MuiLink
                href="https://developer.paypal.com/docs/checkout/"
                target="_blank"
                rel="noopener"
              >
                developer.paypal.com/docs/checkout
              </MuiLink>
              .
            </Typography>
          </Box>
        </Box>
      </Container>
    </>
  );
}