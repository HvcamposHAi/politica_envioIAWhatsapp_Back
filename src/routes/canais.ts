// Rotas de comando de canal (plano-base §5, tabela de contrato front/back).
//
// Regra de ouro: o backend só recebe comando e devolve 202. O resultado
// (QR real, status conectado) chega ao front por Realtime via
// hub.eventos_canal — nenhuma destas rotas devolve o QR no corpo da
// resposta.
//
// ESCOPO (auditoria 2026-08-09, item 1): até esta correção as três rotas
// exigiam apenas autenticação. Como `obterOuCriarCanal` usa supabaseAdmin
// (service_role, ignora RLS), qualquer atendente autenticado de qualquer
// empresa podia comandar a linha de outra — e `DELETE /sessao` cai em
// `desconectar()` sem `preservarSessao`, que executa `socket.logout()` e
// DESPAREIA o aparelho. Agora as três fazem o mesmo prólogo das rotas de
// conversa: atendente por tabela, depois escopo por empresa.
import { Router } from 'express';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { supabaseAdmin } from '../db/client.server.js';
import { obterOuCriarCanal, canalEmMemoria, removerCanal } from '../channels/registry.js';
import { buscarAtendenteAutenticado, canalNoEscopo, type AtendenteRow } from '../auth/escopoConversa.js';
import { invalidarCacheOptInGrupos } from '../services/grupos.js';

export const canaisRouter = Router();
canaisRouter.use(requireSupabaseAuth());

/** Prólogo comum às rotas de canal. Devolve o atendente quando pode seguir, ou
 *  `{ erro, mensagem }` para a rota responder — mesmo formato de
 *  `exigirAdminChamador` em routes/atendentes.ts.
 *
 *  `exigirAdmin` fecha a incoerência I6 do PLANO_GOVERNANCA_ACESSOS.md: conectar
 *  e apagar a sessão são operações de INFRAESTRUTURA — `DELETE /sessao` chama
 *  `logout()` de protocolo e **despareia o aparelho** da linha, derrubando o
 *  atendimento da empresa inteira. A UI só oferece isso em Configurações, que é
 *  admin-only, mas a rota aceitava qualquer atendente ativo da empresa: bastava
 *  um curl com o token de um operador. A RLS de `hub.canais` já exige admin
 *  para escrita (`canais_admin_write`); a rota agora diz a mesma coisa.
 *
 *  `GET /status` fica liberado a quem está no escopo da empresa — é o semáforo
 *  que Configurações consulta em poll, é somente leitura, e não comanda nada. */
async function autorizarCanal(
  userId: string,
  canalId: string,
  opcoes: { exigirAdmin?: boolean } = {},
): Promise<AtendenteRow | { erro: number; mensagem: string }> {
  const atendente = await buscarAtendenteAutenticado(userId);
  if (!atendente) {
    return { erro: 403, mensagem: 'Usuário autenticado não corresponde a um atendente ativo em hub.atendentes.' };
  }
  const noEscopo = await canalNoEscopo(atendente, canalId);
  if (noEscopo === null) return { erro: 404, mensagem: 'Canal não encontrado.' };
  if (!noEscopo) return { erro: 403, mensagem: 'Canal fora do escopo deste atendente.' };
  // Depois do escopo, de propósito: um id inexistente responde 404 mesmo para
  // não-admin, em vez de esconder o erro de digitação atrás de um 403.
  if (opcoes.exigirAdmin && atendente.perfil !== 'admin') {
    return { erro: 403, mensagem: 'Apenas administradores podem conectar ou desconectar uma linha.' };
  }
  return atendente;
}

canaisRouter.post('/canais/:id/conectar', async (req, res) => {
  try {
    const autorizado = await autorizarCanal(req.auth!.userId, req.params.id, { exigirAdmin: true });
    if ('erro' in autorizado) return res.status(autorizado.erro).json({ error: autorizado.mensagem });

    const canal = await obterOuCriarCanal(req.params.id);
    // Não aguarda a conexão terminar — QR/estado chegam por Realtime.
    void canal.conectar();
    res.status(202).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

canaisRouter.delete('/canais/:id/sessao', async (req, res) => {
  try {
    const autorizado = await autorizarCanal(req.auth!.userId, req.params.id, { exigirAdmin: true });
    if ('erro' in autorizado) return res.status(autorizado.erro).json({ error: autorizado.mensagem });

    const canal = canalEmMemoria(req.params.id);
    if (!canal) {
      return res
        .status(404)
        .json({ error: 'canal não está em memória (já desconectado ou nunca conectado)' });
    }
    await canal.desconectar();
    // Tira o objeto do Map do registry. Depois de um logout() de protocolo
    // a sessão está morta e a instância não serve mais para nada — mantê-la
    // ali só fazia o próximo obterOuCriarCanal() devolver um zumbi que
    // carregava estado do ciclo anterior (era a segunda metade da causa 2
    // do diagnóstico 2026-08-14: `encerrandoIntencionalmente` grudado em
    // true). Não toca em hub.canais — o canal continua cadastrado, só sai
    // da memória.
    removerCanal(req.params.id);
    res.status(202).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Liga/desliga a ingestão de mensagens de GRUPO nesta linha.
 *
 * Existe como rota (e não como um UPDATE direto do front pelo PostgREST, que a
 * policy canais_admin_write já permitiria) por um motivo concreto: o backend
 * cacheia este flag por 60s para não fazer um SELECT por mensagem numa rajada
 * de grupo. Passando por aqui, o cache é invalidado na hora e o admin vê
 * efeito na conversa seguinte, não daqui a um minuto.
 *
 * SÓ ADMIN: ligar isto muda o que entra na Caixa e no Painel de todo o setor.
 */
canaisRouter.post('/canais/:id/grupos', async (req, res) => {
  try {
    const autorizado = await autorizarCanal(req.auth!.userId, req.params.id);
    if ('erro' in autorizado) return res.status(autorizado.erro).json({ error: autorizado.mensagem });
    if (autorizado.perfil !== 'admin') {
      return res.status(403).json({ error: 'Só um administrador pode mudar a recepção de grupos de uma linha.' });
    }

    const receber = (req.body ?? {}).receber;
    if (typeof receber !== 'boolean') {
      return res.status(400).json({ error: 'Informe "receber": true ou false.' });
    }

    const { error } = await supabaseAdmin
      .from('canais')
      .update({ receber_grupos: receber })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    invalidarCacheOptInGrupos(req.params.id);
    res.status(200).json({ receber_grupos: receber });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

canaisRouter.get('/canais/:id/status', async (req, res) => {
  try {
    const autorizado = await autorizarCanal(req.auth!.userId, req.params.id);
    if ('erro' in autorizado) return res.status(autorizado.erro).json({ error: autorizado.mensagem });

    // Contrato preservado de propósito: canal que EXISTE e está no escopo mas
    // não tem sessão viva responde 200 'desconectado', não 404 — é o que o
    // semáforo de Configurações → Canais consome em poll de 30s. Só id
    // inexistente virou 404 (antes também respondia 200 'desconectado').
    const canal = canalEmMemoria(req.params.id);
    if (!canal) return res.status(200).json({ status: 'desconectado' });
    res.status(200).json({ status: await canal.status() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
