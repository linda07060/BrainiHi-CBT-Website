import React, { useEffect, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { Box, Container, Typography, Button, CircularProgress } from "@mui/material";
import Header from "../../components/Header";
import axios from "axios";

/**
 * Receipt page: /receipt/[id]
 * Robust, type-safe implementation:
 * - Primary: GET /api/payments/:id (authenticated)
 * - Fallback: GET /api/payments/find/:identifier (authenticated) which searches by PayPal order/capture id, invoice id, client_temp_id etc.
 *
 * Fixed TypeScript issue: ensure route id is normalized to a concrete string (no undefined) before using in requests/encodeURIComponent.
 */

/* ---------- Helpers ---------- */

function tryParseRaw(raw: any): any | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function extractPayPalIdsFromRaw(raw: any): { orderId?: string | null; captureId?: string | null } {
  if (!raw) return { orderId: null, captureId: null };
  try {
    const r = typeof raw === "string" ? tryParseRaw(raw) : raw;
    if (!r) return { orderId: null, captureId: null };

    // common direct fields
    const orderCandidates = [
      r?.paypal_order_id,
      r?.paypalOrderId,
      r?.order_id,
      r?.orderId,
      r?.orderID,
      r?.raw?.paypal_order_id,
      r?.raw?.paypalOrderId,
      r?.__meta?.paypal_order_id,
    ];
    for (const c of orderCandidates) {
      if (c && String(c).trim() !== "") return { orderId: String(c), captureId: null };
    }

    // purchases -> payments -> captures
    try {
      const pu = (r?.purchase_units && r.purchase_units[0]) || (r?.purchaseUnits && r.purchaseUnits[0]) || null;
      if (pu) {
        const payments = pu.payments ?? null;
        const captures = payments?.captures ?? null;
        if (Array.isArray(captures) && captures.length > 0) {
          const cap = captures[0];
          if (cap?.id) return { orderId: cap?.id ?? null, captureId: cap?.id ?? null };
        }
        if (pu.reference_id) return { orderId: pu.reference_id, captureId: null };
        if (pu.invoice_id) return { orderId: pu.invoice_id, captureId: null };
      }
    } catch {}

    // fallback: try to discover alphanumeric tokens (avoid pure numeric DB ids)
    try {
      const s = JSON.stringify(r);
      const matches = s.match(/\b([A-Z0-9]{6,})\b/gi);
      if (matches && matches.length > 0) {
        for (const m of matches) {
          if (!/^\d+$/.test(m)) return { orderId: m, captureId: null };
        }
        return { orderId: matches[0], captureId: null };
      }
    } catch {}

    return { orderId: null, captureId: null };
  } catch {
    return { orderId: null, captureId: null };
  }
}

function normalizeServerRow(row: any) {
  if (!row) return null;
  const raw = row?.raw ? (typeof row.raw === "string" ? tryParseRaw(row.raw) : row.raw) : row;
  const id = row?.id ?? row?.paymentId ?? row?.invoiceId ?? raw?.id ?? null;
  const plan = row?.plan ?? raw?.plan ?? raw?.plan_name ?? null;
  const billingPeriod = row?.billing_period ?? row?.billingPeriod ?? null;
  const amountNum = row?.amount ?? raw?.amount ?? raw?.total ?? 0;
  const amount = typeof amountNum === "number" ? amountNum.toFixed?.(2) ?? String(amountNum) : String(amountNum ?? "0.00");
  const currency = row?.currency ?? raw?.currency ?? raw?.currency_code ?? "USD";
  const status = (row?.status ?? raw?.status ?? "pending") as string;
  const createdAtCandidate = row?.createdAt ?? row?.created_at ?? row?.date ?? raw?.createdAt ?? raw?.created_at ?? raw?.date ?? null;
  const createdAt = createdAtCandidate ? new Date(createdAtCandidate).toISOString() : new Date().toISOString();
  const payerEmail = row?.payer_email ?? raw?.payer?.email_address ?? raw?.payerEmail ?? null;
  let payerName = row?.payer_name ?? raw?.payer?.name ?? null;
  if (payerName && typeof payerName === "object") {
    payerName = `${payerName?.given_name ?? ""} ${payerName?.surname ?? ""}`.trim() || null;
  }

  const { orderId, captureId } = extractPayPalIdsFromRaw(raw);

  return {
    id,
    plan,
    billingPeriod,
    amount,
    currency,
    status,
    paypalOrderId: orderId ?? row?.paypal_order_id ?? row?.paypalOrderId ?? null,
    paypalCaptureId: captureId ?? row?.paypal_capture_id ?? row?.paypalCaptureId ?? null,
    createdAt,
    payerEmail,
    payerName,
    raw,
  };
}

/* ---------- Component ---------- */

export default function ReceiptPage(): JSX.Element {
  const router = useRouter();
  const idParam = router.query.id;

  const [loading, setLoading] = useState<boolean>(true);
  const [payment, setPayment] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // normalize id param (string | string[] | undefined) -> single string or undefined
    let idStr: string | undefined;
    if (typeof idParam === "string") idStr = idParam;
    else if (Array.isArray(idParam) && idParam.length > 0) idStr = idParam[0];
    else idStr = undefined;

    if (!idStr) {
      // If there is no id in the route yet (initial render) just wait
      return;
    }

    // Convert to concrete string for use inside async functions so TS knows it's defined
    const idForRequest = String(idStr);

    let mounted = true;
    setLoading(true);
    setError(null);
    setPayment(null);

    async function loadReceipt() {
      // Primary attempt: server row lookup (may be numeric DB id)
      try {
        const res = await axios.get<any>(`/api/payments/${encodeURIComponent(idForRequest)}`, { withCredentials: true });
        if (!mounted) return;
        const normalized = normalizeServerRow(res?.data ?? null);
        if (normalized) {
          setPayment(normalized);
          return;
        }
      } catch (errAny: any) {
        const status = errAny?.response?.status ?? null;
        if (status === 401 || status === 403) {
          if (mounted) setError("Authentication required to view receipt. Please sign in and try again.");
          return;
        }
        // If 404 or other non-fatal, attempt fallback below
      }

      // Fallback: a safe server-side search endpoint that will only return results owned by the user
      try {
        const res2 = await axios.get<any>(`/api/payments/find/${encodeURIComponent(idForRequest)}`, { withCredentials: true });
        if (!mounted) return;
        const normalized = normalizeServerRow(res2?.data ?? null);
        if (normalized) {
          // If the returned canonical id differs and is numeric, navigate to the canonical receipt URL
          if (normalized.id && String(normalized.id) !== idForRequest && /^\d+$/.test(String(normalized.id))) {
            try {
              router.replace(`/receipt/${encodeURIComponent(String(normalized.id))}`);
              return;
            } catch {}
          }
          setPayment(normalized);
          return;
        }
        if (mounted) setError("Receipt not found.");
      } catch (err2: any) {
        const msg = err2?.response?.data?.message ?? err2?.message ?? "Unable to fetch receipt.";
        if (mounted) setError(msg);
      }
    }

    loadReceipt()
      .catch((e) => {
        if (mounted) setError(String(e?.message ?? "Unknown error"));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idParam]);

  function handleGoDashboard() {
    if (idParam) router.push(`/dashboard?receipt=${Array.isArray(idParam) ? idParam[0] : idParam}`);
    else router.push("/dashboard");
  }

  if (loading) {
    return (
      <>
        <Header />
        <Container maxWidth="sm" sx={{ py: 6 }}>
          <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
            <CircularProgress />
          </Box>
        </Container>
      </>
    );
  }

  if (error || !payment) {
    return (
      <>
        <Header />
        <Container maxWidth="sm" sx={{ py: 6 }}>
          <Typography variant="h6">Receipt</Typography>
          <Typography variant="body2" color="error" sx={{ mt: 2 }}>
            {error ?? "Receipt not found."}
          </Typography>
          <Box sx={{ mt: 3 }}>
            <Button onClick={() => router.push("/dashboard")}>Back to dashboard</Button>
          </Box>
        </Container>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>Receipt — BrainiHi</title>
      </Head>

      <Header />

      <Container maxWidth="md" sx={{ py: 6 }}>
        <Box sx={{ p: 3, borderRadius: 2, boxShadow: 1 }}>
          <Typography variant="h5" sx={{ mb: 1 }}>
            Payment receipt
          </Typography>

          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 2 }}>
            Receipt ID: {String(payment.id ?? "—")}
          </Typography>

          <Box sx={{ mb: 1 }}>
            <Typography variant="body2">Plan: <strong>{payment.plan ?? "—"}</strong></Typography>
            <Typography variant="body2">Billing period: <strong>{payment.billingPeriod ?? "one-off"}</strong></Typography>
            <Typography variant="body2">Amount: <strong>{payment.amount ?? "0.00"} {payment.currency ?? "USD"}</strong></Typography>
            <Typography variant="body2">Status: <strong>{payment.status ?? "pending"}</strong></Typography>
            <Typography variant="body2">PayPal Order ID: <strong>{payment.paypalOrderId ?? (payment.raw?.paypal_order_id ?? payment.raw?.order_id ?? "—")}</strong></Typography>
            <Typography variant="body2">PayPal Capture ID: <strong>{payment.paypalCaptureId ?? (payment.raw?.paypal_capture_id ?? "—")}</strong></Typography>
            <Typography variant="body2">Date: <strong>{payment.createdAt ? new Date(payment.createdAt).toLocaleString() : "—"}</strong></Typography>
          </Box>

          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2">Payer details</Typography>
            <Typography variant="body2">{payment.payerName ?? payment.payerEmail ?? "—"}</Typography>
          </Box>

          <Box sx={{ mt: 3, display: "flex", gap: 2 }}>
            <Button variant="contained" onClick={() => {
              const receiptUrl = payment.raw?.receipt_url ?? payment.raw?.receiptUrl ?? `/receipt/${encodeURIComponent(String(payment.id ?? ""))}`;
              try {
                const w = window.open(receiptUrl, "_blank", "noopener,noreferrer");
                if (w) {
                  setTimeout(() => {
                    try {
                      w.focus?.();
                      w.print?.();
                    } catch {}
                  }, 600);
                }
              } catch {
                window.open(receiptUrl, "_blank", "noopener,noreferrer");
              }
            }}>
              Print
            </Button>
            <Button variant="outlined" onClick={handleGoDashboard}>Go to dashboard</Button>
          </Box>
        </Box>
      </Container>
    </>
  );
}