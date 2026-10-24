/**
 * Discover HTTP proxies for Antigravity accounts from the local Docker daemon.
 *
 * The Mullvad proxies are ordinary Docker containers running an HTTP proxy on
 * port 8888. The DSH plugin runs on the host, so it cannot resolve their
 * container names the way a containerized client can; it addresses them by
 * their bridge IP instead (a published loopback port is preferred when one
 * exists). Discovery is live rather than cached because a container gets a new
 * bridge IP whenever it is recreated.
 *
 * Recognised containers are the ones sub2api's one-click creator labels, plus
 * the ones the deploy/spin-proxy.sh helper creates by name.
 */
import { request as httpRequest } from "node:http";

export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
export const DEFAULT_PROXY_PORT = 8888;
const MANAGED_LABEL = "sub2api.managed";
const MANAGED_LABEL_VALUE = "mullvad-proxy";
const MANAGED_NAME_PREFIX = "mullvad-";
const REQUEST_TIMEOUT_MS = 4000;

function dockerGet(socketPath, apiPath, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath, path: apiPath, method: "GET", timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`docker ${apiPath} returned HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`docker ${apiPath} returned invalid JSON: ${error.message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("docker request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** True when a container looks like a proxy this plugin should offer. */
export function isProxyContainer(container, namePrefix = MANAGED_NAME_PREFIX) {
  const labels = container && container.Labels ? container.Labels : {};
  if (labels[MANAGED_LABEL] === MANAGED_LABEL_VALUE) return true;
  const name = containerName(container);
  return Boolean(name) && name.startsWith(namePrefix);
}

export function containerName(container) {
  const names = container && Array.isArray(container.Names) ? container.Names : [];
  const first = names.find((value) => typeof value === "string" && value.length > 0);
  return first ? first.replace(/^\/+/, "") : "";
}

/**
 * Pick the address this host can actually dial for the given proxy port.
 * A published loopback binding wins (stable across container recreation);
 * otherwise fall back to the container's bridge IP.
 */
export function proxyURLFor(container, port = DEFAULT_PROXY_PORT) {
  const bindings = container && container.Ports ? container.Ports : [];
  const published = bindings.find(
    (entry) =>
      entry &&
      entry.PrivatePort === port &&
      typeof entry.PublicPort === "number" &&
      (!entry.HostIp || entry.HostIp === "127.0.0.1" || entry.HostIp === "0.0.0.0"),
  );
  if (published) {
    return `http://127.0.0.1:${published.PublicPort}`;
  }
  const networks = (container && container.NetworkSettings && container.NetworkSettings.Networks) || {};
  for (const entry of Object.values(networks)) {
    const ip = entry && typeof entry.IPAddress === "string" ? entry.IPAddress : "";
    if (ip) return `http://${ip}:${port}`;
  }
  return "";
}

/**
 * List the proxy containers available to this host.
 *
 * Never throws: a missing socket or an unreachable daemon is reported as
 * `available: false` with a reason, so the caller can show that instead of
 * failing the whole settings panel.
 */
export async function discoverDockerProxies(options = {}) {
  const socketPath =
    typeof options.socketPath === "string" && options.socketPath.trim()
      ? options.socketPath.trim()
      : DEFAULT_DOCKER_SOCKET;
  const port = Number.isInteger(options.port) && options.port > 0 ? options.port : DEFAULT_PROXY_PORT;
  const namePrefix =
    typeof options.namePrefix === "string" && options.namePrefix ? options.namePrefix : MANAGED_NAME_PREFIX;

  let containers;
  try {
    containers = await dockerGet(socketPath, "/containers/json?all=1");
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    return {
      available: false,
      reason: `Cannot reach the Docker daemon at ${socketPath}: ${reason}`,
      proxies: [],
    };
  }
  if (!Array.isArray(containers)) {
    return { available: false, reason: "Docker returned an unexpected container list.", proxies: [] };
  }

  const proxies = [];
  for (const container of containers) {
    if (!isProxyContainer(container, namePrefix)) continue;
    const name = containerName(container);
    const url = proxyURLFor(container, port);
    if (!name || !url) continue;
    const labels = container.Labels || {};
    const relay = typeof labels["sub2api.relay"] === "string" ? labels["sub2api.relay"] : "";
    const running = container.State === "running";
    proxies.push({
      id: container.Id ? String(container.Id).slice(0, 12) : name,
      name,
      url,
      relay,
      running,
      // The label is the human-facing text; keep it stable so a running/paused
      // container is obvious rather than looking like a different proxy.
      label: [name, relay].filter(Boolean).join(" · ") + (running ? "" : ` (${container.State || "not running"})`),
    });
  }
  proxies.sort((left, right) => left.name.localeCompare(right.name));
  return { available: true, proxies };
}
