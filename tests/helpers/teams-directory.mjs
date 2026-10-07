import { createServer } from "node:http";

export const teamsDirectoryContext = {
  appId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  teamId: "33333333-3333-4333-8333-333333333333",
};
export const teamsNativeId = "19:general@thread.tacv2";
export const teamsMemberId = "44444444-4444-4444-8444-444444444444";
export const teamsLink = `https://teams.microsoft.com/l/team/${encodeURIComponent(teamsNativeId)}/conversations?groupId=${teamsDirectoryContext.teamId}`;

/** HTTP protocol fixture at the Microsoft boundary; not live Graph/RSC consent proof. */
export async function teamsDirectoryProvider(t) {
  const calls = [];
  const path = `/v1.0/teams/${teamsDirectoryContext.teamId}`;
  const routes = new Map([
    [
      `/${teamsDirectoryContext.tenantId}/oauth2/v2.0/token`,
      { body: { access_token: "synthetic-graph-access-token", token_type: "Bearer" } },
    ],
    [`${path}/primaryChannel`, { body: { id: teamsNativeId } }],
    [
      `${path}/channels`,
      {
        body: {
          value: [
            { id: teamsNativeId, displayName: "General", membershipType: "standard" },
            {
              id: "19:engineering@thread.tacv2",
              displayName: "Engineering",
              membershipType: "standard",
            },
            { id: "19:private@thread.tacv2", displayName: "Private", membershipType: "private" },
          ],
        },
      },
    ],
    [
      `${path}/members`,
      {
        body: {
          value: [
            {
              id: "opaque-membership-id",
              userId: teamsMemberId,
              displayName: "Alex Chen",
              email: "alex@example.com",
            },
          ],
        },
      },
    ],
  ]);
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    calls.push({ url, headers: request.headers, method: request.method, body });
    const route = routes.get(
      url.pathname +
        (url.searchParams.has("$skiptoken") ? `?${url.searchParams.get("$skiptoken")}` : ""),
    );
    route?.started?.();
    await route?.wait;
    response.writeHead(route?.status ?? (route ? 200 : 404), {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(route?.body ?? { error: { code: "NotFound" } }), () =>
      route?.completed?.(),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    routes,
    path,
    request(url, options) {
      const target = new URL(url);
      if (
        !["https://login.microsoftonline.com", "https://graph.microsoft.com"].includes(
          target.origin,
        )
      ) {
        throw new Error("Unexpected external host");
      }
      return fetch(new URL(target.pathname + target.search, origin), options);
    },
  };
}
