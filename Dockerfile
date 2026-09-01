# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg: converte o áudio gravado no navegador (webm/opus, o que o
# MediaRecorder do Chrome produz) para opus/ogg, que é o único formato em que
# o WhatsApp exibe a NOTA DE VOZ de verdade — com onda e botão de play. Sem
# isto, o atendente grava, o Hub diz "enviado", e boa parte dos Androids do
# outro lado mostra um anexo que não toca (ver services/audioVoz.ts).
# Custo: ~75 MB na imagem. O código degrada com mensagem explícita se o
# binário não estiver aqui, mas essa não é a experiência que foi aprovada.
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Cloud Run injeta PORT=8080 em runtime; o default 8081 no código
# (src/server.ts) só vale para uso local fora do Cloud Run. Não
# sobrescrever PORT aqui.
EXPOSE 8081

CMD ["node", "dist/server.js"]
