FROM node:24-slim

# Claude Code em modo não interativo (claude -p). Autentica pelo CLAUDE_CODE_OAUTH_TOKEN do .env.
RUN npm install -g @anthropic-ai/claude-code@2.1.319

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# /work é a pasta do agente: vazia. Ele não tem ferramenta de arquivo, mas nem teria o que ler.
RUN mkdir -p /work /runs && chown -R node:node /work /runs /app
USER node
ENV HOME=/home/node \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

EXPOSE 8100
CMD ["node", "server.mjs"]
