// The settings panel lists proxies discovered on this host, so the discovery has
// to be correct about two things that are easy to get wrong: which containers
// count as proxies, and which address this host can actually dial. A container's
// bridge IP is only reachable from the host, and it changes when the container is
// recreated — hence live discovery with a published-port preference.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverDockerProxies,
  isProxyContainer,
  proxyURLFor,
  containerName,
} from "../lib/docker-proxies.js";

test("isProxyContainer accepts the managed label and the name prefix", () => {
  assert.equal(isProxyContainer({ Names: ["/mullvad-google"], Labels: {} }), true);
  assert.equal(
    isProxyContainer({ Names: ["/whatever"], Labels: { "sub2api.managed": "mullvad-proxy" } }),
    true,
  );
  // A container that is neither labelled nor named like a proxy stays out.
  assert.equal(isProxyContainer({ Names: ["/postgres"], Labels: {} }), false);
  assert.equal(isProxyContainer({ Names: ["/my-mullvad-thing"], Labels: {} }), false);
  assert.equal(isProxyContainer({}), false);
  assert.equal(isProxyContainer(null), false);
});

test("containerName strips the docker slash", () => {
  assert.equal(containerName({ Names: ["/mullvad-google"] }), "mullvad-google");
  assert.equal(containerName({ Names: ["mullvad-google"] }), "mullvad-google");
  assert.equal(containerName({ Names: [] }), "");
});

test("proxyURLFor prefers a published loopback port over the bridge IP", () => {
  const published = {
    Ports: [{ PrivatePort: 8888, PublicPort: 18888, HostIp: "127.0.0.1", Type: "tcp" }],
    NetworkSettings: { Networks: { "deploy_sub2api-network": { IPAddress: "172.18.0.5" } } },
  };
  assert.equal(proxyURLFor(published), "http://127.0.0.1:18888");

  const bridgeOnly = {
    Ports: [],
    NetworkSettings: { Networks: { "deploy_sub2api-network": { IPAddress: "172.18.0.5" } } },
  };
  assert.equal(proxyURLFor(bridgeOnly), "http://172.18.0.5:8888");

  // A published binding for a different private port is not this proxy's.
  assert.equal(
    proxyURLFor({
      Ports: [{ PrivatePort: 8000, PublicPort: 18000, HostIp: "127.0.0.1" }],
      NetworkSettings: { Networks: { net: { IPAddress: "172.18.0.9" } } },
    }),
    "http://172.18.0.9:8888",
  );

  assert.equal(proxyURLFor({ Ports: [], NetworkSettings: { Networks: {} } }), "");
});

/** Serve a canned Docker API over a temporary unix socket. */
async function withFakeDocker(t, containers, run) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-docker-"));
  const socketPath = join(dir, "docker.sock");
  const server = createServer((req, res) => {
    if (req.url && req.url.startsWith("/containers/json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(containers));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return run(socketPath);
}

test("discoverDockerProxies lists proxy containers and skips everything else", async (t) => {
  const containers = [
    {
      Id: "aaaaaaaaaaaa1111",
      Names: ["/mullvad-google"],
      State: "running",
      Labels: { "sub2api.managed": "mullvad-proxy", "sub2api.relay": "us-dal-wg-001" },
      Ports: [],
      NetworkSettings: { Networks: { net: { IPAddress: "172.18.0.5" } } },
    },
    {
      Id: "bbbbbbbbbbbb2222",
      Names: ["/mullvad-google-2"],
      State: "exited",
      Labels: {},
      Ports: [{ PrivatePort: 8888, PublicPort: 18889, HostIp: "127.0.0.1" }],
      NetworkSettings: { Networks: { net: { IPAddress: "172.18.0.6" } } },
    },
    { Id: "cccccccccccc3333", Names: ["/sub2api-postgres"], State: "running", Labels: {}, Ports: [] },
  ];

  const result = await withFakeDocker(t, containers, (socketPath) =>
    discoverDockerProxies({ socketPath }),
  );

  assert.equal(result.available, true);
  assert.deepEqual(
    result.proxies.map((entry) => [entry.name, entry.url, entry.running]),
    [
      ["mullvad-google", "http://172.18.0.5:8888", true],
      ["mullvad-google-2", "http://127.0.0.1:18889", false],
    ],
  );
  // The label carries the relay, and a stopped container says so.
  assert.equal(result.proxies[0].label, "mullvad-google · us-dal-wg-001");
  assert.match(result.proxies[1].label, /not running|exited/);
});

test("discoverDockerProxies reports an unreachable daemon instead of throwing", async () => {
  const result = await discoverDockerProxies({ socketPath: "/nonexistent/docker.sock" });
  assert.equal(result.available, false);
  assert.deepEqual(result.proxies, []);
  assert.match(result.reason, /Cannot reach the Docker daemon/);
});
