#!/usr/bin/env bash
# Deploy do central-api (Central de Mensagens da campanha). USE ESTE SCRIPT, não `gcloud run deploy` à mão.
#
# POR QUE ELE EXISTE (diagnóstico 2026-08-14, causa 3 das quedas periódicas):
# este serviço é um gateway STATEFUL — ele segura, em memória, um WebSocket
# por linha de WhatsApp (channels/registry.ts). Três flags do Cloud Run não
# são otimização, são pré-requisito de funcionamento:
#
#   --min-instances=1     sem isto a instância morre por ociosidade. O SIGTERM
#                         que vem junto derruba todas as linhas, e ninguém
#                         está por perto para perceber. É a queda "de
#                         madrugada, sem ninguém ter mexido em nada".
#
#   --max-instances=1     com mais de uma instância, cada uma roda o
#                         boot-reconnect nos MESMOS canais. Dois sockets na
#                         mesma identidade: o WhatsApp derruba um
#                         (440 connectionReplaced) e as duas entram em duelo
#                         de reconexão.
#
#   --no-cpu-throttling   sem CPU alocada entre requisições HTTP, o keepalive
#                         do WebSocket não roda e a sessão morre sozinha. Foi
#                         a causa final do incidente de 2026-08-08.
#
# Até este script existir, esses três valores viviam só na conta do GCP —
# qualquer `gcloud run deploy --source .` feito por outra pessoa podia não
# reproduzi-los, e a correção tinha prazo de validade.
#
# Uso:  ./deploy.sh            (deploy a partir do fonte, no commit atual)
#       ./deploy.sh --dry-run  (mostra o comando e sai, sem publicar nada)

set -euo pipefail

SERVICO="${SERVICO:-central-api}"
REGIAO="${REGIAO:-southamerica-east1}"

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY="echo [dry-run] "
else
  DRY=""
fi

# Deploy a partir de árvore suja é como duas sessões trabalhando em paralelo
# publicaram código que ninguém revisou (incidente 2026-08-07). Avisa e exige
# confirmação — não bloqueia, porque hotfix urgente é um caso real.
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "AVISO: a árvore de trabalho tem alterações não commitadas."
  echo "       O que for publicado agora não corresponde a nenhum commit."
  read -r -p "       Continuar mesmo assim? [s/N] " resposta
  [[ "${resposta,,}" == "s" ]] || { echo "Abortado."; exit 1; }
fi

echo "==> Testes antes de publicar"
$DRY npm test

echo "==> Publicando ${SERVICO} em ${REGIAO}"
$DRY gcloud run deploy "${SERVICO}" \
  --source . \
  --region "${REGIAO}" \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling

if [[ -n "${DRY}" ]]; then exit 0; fi

# Conferência obrigatória. Um `gcloud run deploy` que falha no build pode
# republicar a imagem `latest` ANTERIOR e ainda assim criar uma revisão nova
# com cara de sucesso (incidente do "deploy verde com imagem velha"): o nome
# da revisão não prova nada, o digest e a data de criação provam.
echo
echo "==> Confira ANTES de dar o deploy por bom:"
gcloud run services describe "${SERVICO}" --region "${REGIAO}" \
  --format="yaml(status.latestReadyRevisionName,
                 spec.template.spec.containers[0].image,
                 spec.template.metadata.annotations['autoscaling.knative.dev/minScale'],
                 spec.template.metadata.annotations['autoscaling.knative.dev/maxScale'],
                 spec.template.metadata.annotations['run.googleapis.com/cpu-throttling'])"

echo
echo "minScale e maxScale devem estar em '1', e cpu-throttling em 'false'."
echo "Depois disso, confira no log se as linhas voltaram sozinhas:"
echo "  gcloud logging read 'resource.labels.service_name=\"${SERVICO}\" AND textPayload:\"reconectando canais Baileys\"' --limit=5 --freshness=10m"
