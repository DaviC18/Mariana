# Explicação — escolha de conversa após 24h

## O que eu entendi do problema

Hoje a Mariana não percebe quando o cliente volta depois de mais de 24 horas. A mensagem nova entra na mesma conversa antiga, e o estado comercial (objetivo, tipo de consórcio, situação, interesse no consultor, status) fica no lead, não na conversa. Por isso, criar uma conversa nova sozinha não resolve: a Mariana continuaria achando que o cliente quer um carro quando ele agora quer um imóvel. Também não existe hoje nenhum fechamento por inatividade; isso está só no roteiro (pacote D / WP-4). O plano faz a Mariana perguntar, antes de qualquer resposta automática, se o cliente quer continuar a conversa anterior ou começar uma nova.

## O que eu vou fazer, passo a passo

1. **Criar a regra de tempo.** Uma função única decide se passaram pelo menos 24 horas desde a última mensagem do cliente. Ela trata o limite exato, data nula e data inválida. A janela de envio do WhatsApp continua sendo outra coisa e não é alterada.
2. **Guardar a escolha pendente sem migration.** Como o banco está congelado, a pendência vai numa linha já existente da tabela de tarefas, marcada como concluída, com os dados da escolha. Isso sobrevive a reinício do processo. É uma solução honesta, mas é um uso adaptado da tabela; se você preferir a coluna própria, isso exige migration e o passo fica bloqueado.
3. **Garantir uma única conversa ativa por lead.** Antes de criar conversa, o sistema trava o lead no banco. Duas mensagens ao mesmo tempo, ou um toque junto com uma mensagem, não criam duas conversas ativas.
4. **Mudar a entrada do WhatsApp.** O sistema lê o horário antigo da última mensagem antes de gravar o novo. Se passaram 24h, ele guarda a mensagem, manda a pergunta e não processa nada. Se já existe uma escolha pendente, ele só lembra a pergunta e também não processa.
5. **Criar as mensagens da escolha.** A pergunta tem dois botões: “Continuar” e “Nova conversa”. O cliente vê: “Oi! Já passou mais de 24 horas desde a nossa última conversa. Você prefere continuar de onde paramos ou começar uma conversa nova?”.
6. **Tratar “Continuar”.** A conversa continua a mesma, com o mesmo histórico e o mesmo estado comercial. As mensagens que ficaram esperando são processadas em ordem, e a pergunta de 24h não aparece de novo.
7. **Tratar “Nova conversa”.** A conversa antiga é fechada, mas nada é apagado. Nasce uma conversa nova para o mesmo lead. As mensagens que estavam esperando passam para a conversa nova. A sessão de agendamento antiga é encerrada, e a reunião já marcada não é apagada. O cliente vê: “Pronto, comecei uma conversa nova. Pode me contar o que você procura agora?”.
8. **Zerar o estado comercial na conversa nova.** Antes de zerar, o sistema guarda uma cópia do estado antigo. Objetivo, tipo de consórcio, interesse no consultor, abordagem, situação, motivação e urgência não passam para a conversa nova. Nome, telefone e data de nascimento continuam, porque são dados de identidade.
9. **Resolver o status “agendado”.** Se havia reunião futura confirmada, o lead continua “agendado”. Se a reunião já passou, o lead volta a “novo” na conversa nova. Esse passo depende da sua decisão, porque mexe numa regra que hoje só permite continuar “agendado”.
10. **Bloquear agendamento enquanto a escolha está pendente.** Nenhum toque de horário, confirmação ou consultor pode agir antes da escolha. Toques antigos recebem a pergunta de novo, sem agendar nada.
11. **Tratar casos ruins.** Toque repetido, toque fora de ordem, botão inválido e texto livre durante a pendência têm resposta curta e determinística. Nada é decidido pela IA.
12. **Testar reinício e concorrência.** A escolha pendente funciona depois de reiniciar o processo. Mensagem simultânea ao toque, dois toques ao mesmo tempo e criação de conversa em paralelo não podem gerar duas conversas ativas.
13. **Atualizar a documentação.** A decisão D6 e a linha do WP-4 passam a dizer “perguntar continuar ou nova”, não “fechar e abrir outra”. O mapa do código é atualizado.
14. **Verificação final.** O tester roda as suítes completas, os testes adversariais e confere que nenhum serviço real foi chamado.

## O que NÃO vou mexer

- Não vou criar nem aplicar migration, nem tocar em `drizzle/`, seeds ou `db:push`.
- Não vou apagar conversas, mensagens, reuniões ou dados de A. A conversa antiga fica fechada e recuperável pelo histórico e pela cópia do estado.
- Não vou mudar a janela de envio de 24h do WhatsApp, opt-out, outbox ou regras de confirmação de horário.
- Não vou criar fluxo para reabrir a conversa antiga depois que o cliente escolher a nova.
- Não vou mexer no restante do pacote D/WP-5 nem no prompt além do necessário.
- Não vou rodar testes, fazer commit ou escrever em código de produção agora.

## Riscos

- **Guardar a pendência na tabela de tarefas** funciona, mas é uma adaptação. Se alguém apagar tarefas concluídas no futuro, a pendência se perde. Não existe rotina assim hoje.
- **Zerar o lead** só é seguro porque a cópia do estado é gravada na mesma transação. Se a transação falhar, nada é alterado.
- **O status “agendado”** pode fazer a conversa nova nascer no meio do fluxo de confirmação se a decisão 9 não for aprovada.
- **Concorrência**: a garantia de uma conversa ativa depende de todo caminho de criação usar a mesma trava do lead. O plano centraliza isso e testa.
- **Rollback**: se o código for revertido com escolha pendente em produção, as mensagens ficam esperando e precisam ser liberadas manualmente por você.
- A spec `MARIANA_BEHAVIOR_SPEC.md` v1.1 não existe no repositório. Sem ela, a aceitação final contra as regras `R-SES-*` fica pendente.

## Decisões que preciso de você

1. **Posso guardar a escolha pendente na tabela de tarefas, sem migration?** Recomendo sim. A alternativa correta exige migration e fica bloqueada até o pacote G.
2. **Se a conversa antiga terminou “agendado”, o que a nova herda?** Recomendo: “agendado” só se existir reunião futura confirmada; senão “novo”. Sem isso, a conversa nova nasce presa na confirmação da reunião antiga.
3. **Mensagem durante a pendência recebe um lembrete com os botões?** Recomendo sim, um por mensagem, sem IA e sem processar.
4. **Texto livre decide a escolha?** Recomendo não. Só os botões decidem; texto livre recebe o lembrete. Evita zerar o contexto por engano.
5. **Aprova os textos e os botões “Continuar” / “Nova conversa”?** Recomendo sim; ficam fixos em teste.
6. **Aprova atualizar D6, a linha do WP-4 e dois invariantes no `CLAUDE.md`?** Recomendo sim, no mesmo change.
7. **“Recuperar a conversa antiga” significa só preservar histórico e cópia do estado, sem reabrir?** Recomendo sim; reabrir fica para depois.
8. **Rollback sem feature flag?** Recomendo sim, com teste controlado antes de liberar. Com escolha pendente em produção, o revert exige liberar as mensagens manualmente.

## Pedido de permissão

Posso seguir com este plano? Responda: **aprovo** / **aprovo com mudanças (diga quais)** / **não aprovo**.
