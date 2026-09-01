// Régua única de validação de senha do backend + tradução dos erros do
// GoTrue (plano "Senha no cadastro, reset e troca no primeiro acesso" §3).
//
// Duas responsabilidades, ambas pequenas de propósito:
//
//   1. `validarSenha` — rejeita cedo o que nem vale uma ida ao Supabase
//      (tipo errado, curta demais, longa demais). O limite superior é 72
//      porque o GoTrue guarda a senha com bcrypt, que ignora silenciosamente
//      tudo além do 72º byte: aceitar mais seria prometer uma força que o
//      hash não tem, e ainda deixar duas senhas diferentes logando na mesma
//      conta.
//
//   2. `mensagemErroSenha` — o projeto tem proteção de senha vazada (HIBP)
//      ligada no painel do Supabase, então `createUser`/`updateUserById`
//      podem recusar uma senha perfeitamente válida em tamanho. O erro cru
//      do GoTrue é em inglês e cita "Password"; esta função traduz para a
//      mensagem que o admin/usuário vê no modal.
//
// NUNCA logar, auditar ou ecoar o valor da senha — nenhuma função deste
// arquivo recebe permissão para isso (só devolvem a própria senha para o
// chamador usar na chamada seguinte).

export const SENHA_MIN = 8;
export const SENHA_MAX = 72;

export type ResultadoValidacao = { ok: true; senha: string } | { ok: false; motivo: string };

export function validarSenha(valor: unknown): ResultadoValidacao {
  if (typeof valor !== 'string' || valor.length === 0) {
    return { ok: false, motivo: 'Informe a senha.' };
  }
  if (valor.length < SENHA_MIN) {
    return { ok: false, motivo: `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.` };
  }
  // Contagem em bytes: bcrypt trunca por byte, não por caractere — "é" e
  // emoji ocupam mais de um.
  if (Buffer.byteLength(valor, 'utf8') > SENHA_MAX) {
    return { ok: false, motivo: `A senha é longa demais (máx. ${SENHA_MAX} caracteres).` };
  }
  return { ok: true, senha: valor };
}

/**
 * Traduz o erro do Supabase Auth para uma mensagem de 400 apresentável.
 * Devolve `null` quando o erro NÃO é sobre a força/vazamento da senha —
 * nesse caso o chamador decide o status (409 de e-mail duplicado, 502 de
 * infra, etc.), porque tratar tudo como 400 esconderia falha de serviço.
 */
export function mensagemErroSenha(erro: { code?: string; message?: string } | null): string | null {
  if (!erro) return null;
  const codigo = erro.code ?? '';
  const mensagem = erro.message ?? '';
  if (codigo === 'weak_password' || /weak password|known to be weak|pwned|breach|leaked/i.test(mensagem)) {
    return 'Senha fraca ou já exposta em vazamentos públicos — escolha outra.';
  }
  if (codigo === 'validation_failed' && /password/i.test(mensagem)) {
    return `Senha recusada pelo servidor de autenticação: ${mensagem}`;
  }
  return null;
}

/** `true` quando o e-mail já existe em auth.users (convite anterior, etc.). */
export function ehEmailJaRegistrado(erro: { code?: string; message?: string } | null): boolean {
  if (!erro) return false;
  const codigo = erro.code ?? '';
  const mensagem = erro.message ?? '';
  return (
    codigo === 'email_exists' ||
    codigo === 'user_already_exists' ||
    /already registered|already exists|already been registered/i.test(mensagem)
  );
}
