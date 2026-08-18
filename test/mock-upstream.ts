import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";

/**
 * Mock OpenShock responses use sentinel strings so the anonymity tests can
 * detect any upstream value that leaks into guest-facing output.
 */

export const SENTINEL = {
  owner: "ZZOWNERNAMEZZ",
  ownerId: "11111111-2222-3333-4444-555555555555",
  shareId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  hubName: "ZZHUBNAMEZZ",
  hubId: "12121212-3434-5656-7878-909090909090",
  shockerAName: "ZZSHOCKERAZZ",
  shockerAId: "abababab-cdcd-efef-0101-232323232323",
  shockerBName: "ZZSHOCKERBZZ",
  shockerBId: "bcbcbcbc-dede-f0f0-1212-343434343434",
  avatar: "https://gravatar.example/avatar/ZZEMAILHASHZZ",
};

export interface MockState {
  paused: number;
  shareMissing: boolean;
  controls: unknown[];
  hubInvocations: unknown[];
  failControl: boolean;
  sharedDiscoveryRequests: number;
}

export interface MockUpstream {
  url: string;
  state: MockState;
  close: () => Promise<void>;
}

function sharePayload(state: MockState): unknown {
  return {
    message: "ok",
    data: {
      id: SENTINEL.shareId,
      name: "ZZSHARENAMEZZ",
      createdOn: "2026-01-01T00:00:00Z",
      expiresOn: null,
      author: { id: SENTINEL.ownerId, name: SENTINEL.owner, image: SENTINEL.avatar },
      devices: [
        {
          id: SENTINEL.hubId,
          name: SENTINEL.hubName,
          shockers: [
            {
              id: SENTINEL.shockerAId,
              name: SENTINEL.shockerAName,
              permissions: { vibrate: true, sound: true, shock: true, live: false },
              limits: { intensity: 60, duration: 10000 },
              paused: state.paused,
            },
            {
              id: SENTINEL.shockerBId,
              name: SENTINEL.shockerBName,
              permissions: { vibrate: true, sound: false, shock: false, live: false },
              limits: { intensity: 100, duration: 5000 },
              paused: 0,
            },
          ],
        },
      ],
    },
  };
}

export async function startMockUpstream(): Promise<MockUpstream> {
  const state: MockState = {
    paused: 0,
    shareMissing: false,
    controls: [],
    hubInvocations: [],
    failControl: false,
    sharedDiscoveryRequests: 0,
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/1") return json(200, { version: "mock" });

    if (url.pathname === `/1/public/shares/links/${SENTINEL.shareId}`) {
      if (state.shareMissing) return json(404, { type: "PublicShareNotFound" });
      return json(200, sharePayload(state));
    }
    if (url.pathname.startsWith("/1/public/shares/links/")) {
      return json(404, { type: "PublicShareNotFound" });
    }

    if (url.pathname === "/1/tokens/self") {
      const token = req.headers["openshocktoken"];
      if (token === "bad-token") return json(401, { type: "Unauthorized" });
      if (token === "no-perm-token") return json(200, { data: { permissions: ["shockers.edit"] } });
      return json(200, { data: { permissions: ["shockers.use"], shockerControlPaused: false } });
    }

    if (url.pathname === "/1/shockers/own") {
      return json(200, {
        data: sharePayload(state).data.devices.map((device: any) => ({
          id: device.id,
          name: device.name,
          shockers: device.shockers.map((shocker: any) => ({
            id: shocker.id,
            name: shocker.name,
            isPaused: shocker.paused !== 0,
          })),
        })),
      });
    }
    if (url.pathname === "/1/shockers/shared") {
      state.sharedDiscoveryRequests += 1;
      return json(200, { data: [] });
    }

    if (url.pathname === "/2/shockers/control" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (state.failControl) return json(503, { type: "Unavailable" });
        state.controls.push(JSON.parse(body || "{}"));
        json(200, { message: "sent" });
      });
      return;
    }

    // SignalR negotiate for the public share hub.
    if (url.pathname.endsWith("/negotiate") && req.method === "POST") {
      return json(200, {
        connectionId: "mock-connection",
        connectionToken: "mock-token",
        negotiateVersion: 1,
        availableTransports: [{ transport: "WebSockets", transferFormats: ["Text"] }],
      });
    }

    json(404, { type: "NotFound" });
  });

  // SignalR hub for the public share: handshake, then record Control invocations.
  const RS = "\u001e";
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!/^\/1\/hubs\/share\/link\/[0-9a-fA-F-]{36}$/.test(url.pathname)) {
      socket.destroy();
      return;
    }
    // Upstream aborts a guest connection that does not carry ?name=.
    if (!url.searchParams.get("name")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        for (const frame of String(raw).split(RS)) {
          if (!frame) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(frame) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (msg["protocol"] === "json") {
            ws.send("{}" + RS);
            ws.send(JSON.stringify({ type: 1, target: "Welcome", arguments: [1] }) + RS);
            continue;
          }
          if (msg["type"] === 1 && msg["target"] === "Control") {
            if (state.failControl) {
              ws.close();
              continue;
            }
            state.hubInvocations.push((msg["arguments"] as unknown[])[0]);
          }
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
      }),
  };
}
