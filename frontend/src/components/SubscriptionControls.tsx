import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  Box,
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Chip,
  Stack,
} from "@mui/material";
import type { ChipProps } from "@mui/material";
import axios from "axios";
import UpgradePlanModal from "./UpgradePlanModal";
import Link from "next/link";

// Dynamically import client-only components to avoid SSR/hydration mismatches
const PaymentMethodDisplay = dynamic(() => import("./PaymentMethodDisplay"), { ssr: false });
const BillingHistory = dynamic(() => import("./BillingHistory"), { ssr: false });

type Sub = {
  subscription_id?: string | null;
  plan?: string | null;
  billing_status?: string | null;
  billing_frequency?: string | null;
  next_billing_date?: string | null;
  next_billing_amount?: number | null;
  last_payment_date?: string | null;
  cancel_at_period_end?: boolean;
  payment_method?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number; masked?: string } | null;
  metadata?: any;
};

export default function SubscriptionControls({
  token,
  plan,
  planExpiry,
  onCancelled,
}: {
  token?: string | null;
  plan?: string | null;
  planExpiry?: string | null;
  onCancelled?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [sub, setSub] = useState<Sub | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const apiHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await axios.get<Sub | null>("/api/payments/subscription", { headers: apiHeaders });
        if (!mounted) return;
        setSub(res.data ?? null);
      } catch (err: any) {
        if (!mounted) return;
        setError("Unable to load subscription details.");
        setSub({
          plan: plan ?? null,
          next_billing_date: planExpiry ?? null,
        });
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
    // intentionally depend on token only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function statusColor(status?: string | null): ChipProps["color"] {
    if (!status) return "default";
    const s = String(status).toLowerCase();
    if (s === "active") return "success";
    if (s === "past_due") return "warning";
    if (s === "cancelled" || s === "paused") return "default";
    if (s === "trial") return "info";
    return "default";
  }

  async function doCancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await axios.post<Sub>("/api/payments/cancel", {}, { headers: apiHeaders });
      setSub(res.data ?? null);
      setConfirmOpen(false);
      if (typeof onCancelled === "function") onCancelled();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Unable to cancel subscription.");
    } finally {
      setBusy(false);
    }
  }

  async function doReactivate() {
    setBusy(true);
    setError(null);
    try {
      const res = await axios.post<Sub>("/api/payments/reactivate", {}, { headers: apiHeaders });
      setSub(res.data ?? null);
      setReactivateOpen(false);
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Unable to reactivate subscription.");
    } finally {
      setBusy(false);
    }
  }

  async function openPortal() {
    setBusy(true);
    setError(null);
    try {
      const res = await axios.post<{ url?: string }>("/api/payments/portal", {}, { headers: apiHeaders });
      const url = res?.data?.url ?? null;
      if (url) window.open(url, "_blank");
      else setError("Billing portal unavailable.");
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Unable to open billing portal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ mt: 2 }}>
      <Stack spacing={1}>
        <Stack direction="row" alignItems="center" spacing={1} justifyContent="space-between">
          <Box>
            <Typography variant="caption" color="text.secondary">
              Subscription
            </Typography>
            <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 0.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                {sub?.plan ?? plan ?? "Free"}
              </Typography>
              <Chip label={sub?.billing_status ?? "unknown"} color={statusColor(sub?.billing_status ?? null)} size="small" />
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              {sub?.billing_frequency
                ? `${sub.billing_frequency} billing`
                : sub?.next_billing_date
                ? `Next: ${new Date(sub.next_billing_date).toLocaleDateString()}`
                : ""}
            </Typography>
          </Box>

          <Box sx={{ display: "flex", gap: 1 }}>
            <Button size="small" onClick={() => (window.location.href = "/subscription")} variant="outlined">
              Manage
            </Button>
            {sub?.plan && String(sub.plan).toLowerCase() !== "free" && !sub?.cancel_at_period_end && (
              <Button size="small" color="error" variant="outlined" onClick={() => setConfirmOpen(true)}>
                Cancel
              </Button>
            )}
          </Box>
        </Stack>

        {/* Payment method preview (client-only via dynamic import) */}
        <PaymentMethodDisplay token={token} />

        {/* Quick links */}
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 0.5 }}>
          <Button size="small" onClick={openPortal} disabled={busy}>
            Manage billing
          </Button>
          <Button size="small" onClick={() => setUpgradeOpen(true)}>
            Upgrade
          </Button>
        </Box>

        {error && (
          <Typography variant="caption" color="error">
            {error}
          </Typography>
        )}
      </Stack>

      {/* Cancel confirmation */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Cancel subscription</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to cancel your subscription? Cancelling will stop future renewals. You may retain access until the end of the
            current billing period.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Keep subscription</Button>
          <Button color="error" variant="contained" onClick={doCancel} disabled={busy}>
            {busy ? <CircularProgress size={16} /> : "Cancel subscription"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reactivate confirmation */}
      <Dialog open={reactivateOpen} onClose={() => setReactivateOpen(false)}>
        <DialogTitle>Reactivate subscription</DialogTitle>
        <DialogContent>
          <Typography>Reactivate your subscription to resume auto-renewals and access.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReactivateOpen(false)}>Close</Button>
          <Button color="primary" variant="contained" onClick={doReactivate} disabled={busy}>
            {busy ? <CircularProgress size={16} /> : "Reactivate"}
          </Button>
        </DialogActions>
      </Dialog>

      <UpgradePlanModal open={upgradeOpen} onClose={() => setUpgradeOpen(false)} token={token} />
      {/* Optional compact billing history preview (client-only via dynamic import) */}
      <BillingHistory token={token} compact />
    </Box>
  );
}