//! Framework detection and the generated Dockerfile / docker-compose files.

/// Detect the project framework from package.json
pub(crate) fn detect_framework(project_path: &std::path::Path) -> (String, String, String, u16) {
    let pkg_path = project_path.join("package.json");
    if !pkg_path.exists() {
        return ("static".into(), "echo 'No build needed'".into(), ".".into(), 3000);
    }

    let content = match std::fs::read_to_string(&pkg_path) {
        Ok(c) => c,
        Err(_) => return ("unknown".into(), "npm run build".into(), "dist".into(), 3000),
    };

    let pkg: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return ("unknown".into(), "npm run build".into(), "dist".into(), 3000),
    };

    let deps = pkg["dependencies"].as_object();
    let dev_deps = pkg["devDependencies"].as_object();
    let scripts = pkg["scripts"].as_object();

    let has_dep = |name: &str| -> bool {
        deps.map(|d| d.contains_key(name)).unwrap_or(false)
            || dev_deps.map(|d| d.contains_key(name)).unwrap_or(false)
    };

    if has_dep("next") {
        return ("nextjs".into(), "npm run build".into(), ".next".into(), 3000);
    }
    if has_dep("react") && has_dep("vite") {
        return ("vite-react".into(), "npm run build".into(), "dist".into(), 5173);
    }
    if has_dep("vue") || has_dep("@vue/cli-service") {
        return ("vue".into(), "npm run build".into(), "dist".into(), 8080);
    }
    if has_dep("react") {
        // Check for CRA
        if has_dep("react-scripts") {
            return ("react".into(), "npm run build".into(), "build".into(), 3000);
        }
        return ("react".into(), "npm run build".into(), "dist".into(), 3000);
    }
    if has_dep("express") {
        return ("express".into(), "echo 'No build step'".into(), ".".into(), 3000);
    }
    if has_dep("fastify") {
        return ("fastify".into(), "echo 'No build step'".into(), ".".into(), 3000);
    }

    // Check scripts for build commands
    if let Some(scripts) = scripts {
        if scripts.contains_key("build") {
            return ("node".into(), "npm run build".into(), "dist".into(), 3000);
        }
    }

    ("node".into(), "echo 'No build step'".into(), ".".into(), 3000)
}

/// Generate a Dockerfile for the detected framework
/// Generate a Dockerfile that clones the project repo at build time (instead of relying on a
/// build context). Returns the Dockerfile plus the port the resulting container actually
/// listens on. The clone disables TLS verification to tolerate self-signed homelab certs and
/// uses the token-bearing URL, so it works for forges on IPs/.local that Coolify itself can't
/// clone. `CACHEBUST` changes each generation so a fresh create rebuilds; redeploys pass
/// `force=true` for a no-cache rebuild.
pub(crate) fn generate_clone_dockerfile(
    framework: &str,
    output_dir: &str,
    build_port: u16,
    clone_url: &str,
    branch: &str,
) -> (String, u16) {
    let cachebust = chrono::Utc::now().timestamp();
    // The cachebust is embedded DIRECTLY in the clone RUN command (not just as an `ARG`) so the
    // layer's cache key changes every time the Dockerfile is regenerated — forcing Docker to
    // re-run `git clone` and fetch the latest commit. An `ARG` alone does NOT work: Docker only
    // busts cache at a build-arg's first *usage*, and the old Dockerfile never referenced it, so
    // the clone layer was cached and redeploys kept shipping the code from the first build.
    let node_clone = format!(
        "RUN apk add --no-cache git && echo \"monastery-cachebust {cb}\" && git -c http.sslVerify=false clone --depth 1 --single-branch --branch {b} \"{u}\" . && rm -rf .git",
        cb = cachebust, b = branch, u = clone_url
    );
    // Clone step for the prebuilt alpine/git image (git already present).
    let git_clone = format!(
        "RUN echo \"monastery-cachebust {cb}\" && git -c http.sslVerify=false clone --depth 1 --single-branch --branch {b} \"{u}\" . && rm -rf .git",
        cb = cachebust, b = branch, u = clone_url
    );

    match framework {
        "nextjs" => (format!(
            "FROM node:18-alpine AS builder\nWORKDIR /app\nARG CACHEBUST={cb}\n{clone}\nRUN npm install && npm run build\n\nFROM node:18-alpine AS runner\nWORKDIR /app\nENV NODE_ENV=production\nCOPY --from=builder /app/package*.json ./\nCOPY --from=builder /app/{out} ./{out}\nCOPY --from=builder /app/node_modules ./node_modules\nEXPOSE {p}\nCMD [\"npm\", \"start\"]\n",
            cb = cachebust, clone = node_clone, out = output_dir, p = build_port
        ), build_port),
        "vite-react" | "vue" | "react" => (format!(
            "FROM node:18-alpine AS builder\nWORKDIR /app\nARG CACHEBUST={cb}\n{clone}\nRUN npm install && npm run build\n\nFROM nginx:alpine\nCOPY --from=builder /app/{out} /usr/share/nginx/html\nEXPOSE 80\n",
            cb = cachebust, clone = node_clone, out = output_dir
        ), 80),
        "express" | "fastify" | "node" => (format!(
            "FROM node:18-alpine\nWORKDIR /app\nARG CACHEBUST={cb}\n{clone}\nRUN npm install --production\nEXPOSE {p}\nCMD [\"node\", \"index.js\"]\n",
            cb = cachebust, clone = node_clone, p = build_port
        ), build_port),
        // static / unknown: clone the repo and serve it as static files via nginx (port 80).
        _ => (format!(
            "FROM alpine/git AS source\nWORKDIR /src\nARG CACHEBUST={cb}\n{clone}\n\nFROM nginx:alpine\nCOPY --from=source /src /usr/share/nginx/html\nEXPOSE 80\n",
            cb = cachebust, clone = git_clone
        ), 80),
    }
}

pub(crate) fn generate_dockerfile(framework: &str, _build_cmd: &str, output_dir: &str, port: u16) -> String {
    match framework {
        "nextjs" => format!(
            r#"FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/{} ./{}
COPY --from=builder /app/node_modules ./node_modules
EXPOSE {}
CMD ["npm", "start"]
"#,
            output_dir, output_dir, port
        ),
        "vite-react" | "vue" | "react" => format!(
            r#"FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/{} /usr/share/nginx/html
EXPOSE {}
CMD ["nginx", "-g", "daemon off;"]
"#,
            output_dir, port
        ),
        "express" | "fastify" | "node" => format!(
            r#"FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE {}
CMD ["node", "index.js"]
"#,
            port
        ),
        _ => format!(
            r#"FROM node:18-alpine
WORKDIR /app
COPY . .
EXPOSE {}
CMD ["npx", "serve", "-l", "{}"]
"#,
            port, port
        ),
    }
}

/// Generate a docker-compose.yml that includes Pocketbase
pub(crate) fn generate_docker_compose(app_name: &str, port: u16, include_pocketbase: bool, include_tunnel: bool) -> String {
    let mut services = format!(
        r#"version: "3.8"

services:
  {app}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "{port}:{port}"
"#,
        app = app_name,
        port = port,
    );

    if include_pocketbase {
        services.push_str(&format!(
            r#"    environment:
      - POCKETBASE_URL=http://pocketbase:8090
    depends_on:
      - pocketbase
    restart: unless-stopped

  pocketbase:
    image: ghcr.io/muchobien/pocketbase:latest
    ports:
      - "8090:8090"
    volumes:
      - ./pb_data:/pb_data
    environment:
      - PB_ENCRYPTION_KEY=change-me-in-production
    restart: unless-stopped
"#
        ));
    } else {
        services.push_str("    restart: unless-stopped\n");
    }

    if include_tunnel {
        services.push_str(&format!(
            r#"
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run --token ${{CF_TUNNEL_TOKEN}}
    environment:
      - CF_TUNNEL_TOKEN=${{CF_TUNNEL_TOKEN}}
    restart: unless-stopped
    network_mode: "service:{app}"
    depends_on:
      - {app}
"#,
            app = app_name,
        ));
    }

    services
}
