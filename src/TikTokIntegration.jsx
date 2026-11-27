import { useEffect, useState } from "react";
import { Music2 } from "lucide-react";
import { IntegrationCard } from "./IntegrationCard.jsx";
import { api } from "./model.js";

export function TikTokIntegration({ onDisconnected }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api("/tiktok/status", { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setStatus(next);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);

  async function disconnect() {
    setDisconnecting(true);
    setError("");
    try {
      setStatus(await api("/tiktok/disconnect", { method: "POST" }));
      onDisconnected();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <IntegrationCard
      name="TikTok"
      icon={Music2}
      iconStyle="bg-cyan-100 text-cyan-800"
      description="View account stats and recent public video performance in Overview."
      status={status?.connected ? "connected" : status?.configured ? "disconnected" : status ? "setup" : error ? "unavailable" : null}
      action={status?.connected ? (
        <button className="btn btn-outline btn-sm" type="button" disabled={disconnecting} onClick={disconnect}>Disconnect TikTok</button>
      ) : status?.configured ? (
        <a href={status.authorizeUrl || "/api/tiktok/auth/start"} className="btn btn-primary btn-sm">Connect TikTok</a>
      ) : null}
      error={error}
    />
  );
}
