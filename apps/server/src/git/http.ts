import { spawn } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, workspaces, type Db } from "@cohort/db";
import { userForAccessToken } from "../auth.ts";

// Git smart HTTP (clone, fetch, push), delegated to `git http-backend` as a CGI program.
// Auth is an access token, sent as the password (any username) or as a Bearer token.

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

interface Params {
  workspace: string;
  repo: string;
}

function tokenFromRequest(request: FastifyRequest): string | null {
  const header = request.headers.authorization ?? "";
  const bearer = header.match(/^Bearer (.+)$/)?.[1];
  if (bearer) return bearer;
  const basic = header.match(/^Basic (.+)$/)?.[1];
  if (!basic) return null;
  const decoded = Buffer.from(basic, "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1) || null;
}

function challenge(reply: FastifyReply, message: string) {
  return reply
    .code(401)
    .header("www-authenticate", 'Basic realm="Cohort"')
    .type("text/plain")
    .send(`${message}\nUse a Cohort access token as the password.\n`);
}

export async function gitHttpRoutes(
  app: FastifyInstance,
  { db, reposRoot }: { db: Db; reposRoot: string },
) {
  // Leave git request bodies unread; they are streamed straight into git http-backend.
  app.addContentTypeParser(
    ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
    (_request, _payload, done) => done(null),
  );

  async function handle(request: FastifyRequest<{ Params: Params }>, reply: FastifyReply, rest: string) {
    const token = tokenFromRequest(request);
    const user = token ? userForAccessToken(db, token) : null;
    if (!user) return challenge(reply, token ? "Invalid access token." : "Authentication required.");

    const { workspace } = request.params;
    const project = request.params.repo.replace(/\.git$/, "");
    const found = db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(and(eq(workspaces.slug, workspace), eq(projects.slug, project)))
      .get();
    if (!found) return reply.code(404).type("text/plain").send("Repository not found.\n");

    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : "";
    if (rest === "info/refs") {
      const service = new URLSearchParams(query).get("service");
      // Only the smart protocol is served.
      if (!service || !SERVICES.has(service)) {
        return reply.code(403).type("text/plain").send("Update your git client.\n");
      }
    }

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: reposRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${workspace}/${project}.git/${rest}`,
      QUERY_STRING: query,
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      REMOTE_USER: user.username,
      REMOTE_ADDR: request.ip,
    };
    const passHeaders: Record<string, string> = {
      "content-length": "CONTENT_LENGTH",
      "content-encoding": "HTTP_CONTENT_ENCODING",
      "git-protocol": "GIT_PROTOCOL",
    };
    for (const [header, variable] of Object.entries(passHeaders)) {
      const value = request.headers[header];
      if (typeof value === "string") env[variable] = value;
    }

    reply.hijack();
    const res = reply.raw;
    const child = spawn("git", ["http-backend"], { env });

    if (request.method === "POST") request.raw.pipe(child.stdin);
    else child.stdin.end();

    child.stderr.on("data", (data: Buffer) => request.log.warn({ git: data.toString() }, "git http-backend"));
    child.on("error", (error) => {
      request.log.error(error, "git http-backend failed to start");
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("git http-backend failed.\n");
    });
    res.on("close", () => {
      if (child.exitCode === null) child.kill();
    });

    // CGI output: headers, a blank line, then the body.
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const crlf = head.indexOf("\r\n\r\n");
      const lf = head.indexOf("\n\n");
      const end = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
      if (end === -1) return;
      const sepLength = end === crlf ? 4 : 2;
      child.stdout.off("data", onData);

      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString("latin1").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + sepLength));
      child.stdout.pipe(res);
    };
    child.stdout.on("data", onData);
    child.stdout.on("end", () => {
      // Backend exited without completing its headers.
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Bad response from git http-backend.\n");
      }
    });
  }

  app.get<{ Params: Params }>("/:workspace/:repo/info/refs", (req, reply) => handle(req, reply, "info/refs"));
  for (const service of SERVICES) {
    app.post<{ Params: Params }>(`/:workspace/:repo/${service}`, (req, reply) => handle(req, reply, service));
  }
}
