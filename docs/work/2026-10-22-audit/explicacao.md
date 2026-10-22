# Mariana — explicação em português simples

Davi, este documento conta, sem termos técnicos, o que a auditoria encontrou no código da Mariana. O relatório completo, com os números de linha e as evidências, está em `docs/work/2026-10-22-audit/audit-report.md`. Aqui eu explico o essencial: o que está acontecendo, por que está acontecendo, o que eu recomendo fazer e em que ordem.

Nada foi alterado. Nenhuma linha de código, nenhum teste, nenhuma migração, nenhum arquivo de configuração. Nenhum comando foi executado contra o banco de produção (Neon), contra o WhatsApp, contra o Google Agenda ou contra a API do Gemini. Esta auditoria só leu.

---

## 1. Primeiro: a spec não estava perdida

O pedido da auditoria dizia que o arquivo `MARIANA_BEHAVIOR_SPEC.md` não existia no repositório e que eu precisaria reconstruí-lo por cima das evidências. Isso não era verdade, e é bom que não fosse.

O arquivo existe, está completo, com todas as regras (`R-FLOW-03`, `R-SCH-01` e as outras) e com a lista inteira dos quinze cenários de referência (`S-01` até `S-15`). O que aconteceu é que ele está na **raiz do projeto**, e não dentro de `docs/specs/`, e além disso ele ainda **não foi commitado** — está como arquivo não rastreado pelo Git. Por isso as buscas feitas com ferramentas do Git simplesmente não o encontraram.

A consequência prática é boa: eu não precisei inventar nenhuma régua. Toda a avaliação deste relatório foi feita contra a sua spec de verdade, com os IDs de regra reais e os cenários reais. Mas isso também significa que a régua do projeto está num lugar onde os agentes não a acham e onde ela pode ser perdida num descuido. É o primeiro item da minha lista de perguntas no fim deste documento.

---

## 2. O resumo em uma frase

A Mariana não parece "sem raciocínio" porque o modelo de linguagem seja incapaz. Ela parece sem raciocínio porque o sistema, de um lado, **nunca pede** que ela raciocine, e, de outro lado, **joga no lixo boa parte do que ela escreve** antes de a mensagem chegar ao cliente.

São duas coisas somadas, e as duas são consertáveis sem reescrever a arquitetura.

---

## 3. As cinco causas principais

### Causa 1 — O modelo está configurado para não pensar

O código usa o modelo `gemini-3.5-flash-lite`. O sufixo "lite" é o nível mais barato, mais rápido e menos capaz da família. Isso por si só já seria discutível para a tarefa que ela tem. Mas o problema maior é o que está faltando na configuração: o código **não define orçamento de raciocínio** (nenhum ajuste de "thinking" em nenhum lugar do projeto), **não define a temperatura** (então o modelo roda no padrão, que é alto, ou seja, bastante aleatório) e **não define um limite de tamanho da resposta**.

Ao mesmo tempo, o sistema entrega para esse modelo um texto de instruções de cerca de **cinco mil e seiscentas palavras-token por mensagem**, do qual aproximadamente noventa por cento são regras e proibições, e só uns oito por cento são os fatos que ela tem permissão de usar para responder. Em outras palavras: pedimos que ela equilibre quarenta regras diferentes numa única passada, sem tempo de pensar, com temperatura alta, usando o modelo mais simples disponível.

Além disso, o nome do modelo está escrito direto no código-fonte, e não numa variável de ambiente. Isso já custou caro: o snapshot do Neon mostra **dezenove falhas** entre 13 e 14 de outubro por nome de modelo errado (quatorze vezes "gemini-3.6-flash-lite não encontrado" e quatro vezes "gemini-2.5-flash não está mais disponível"). Cada uma dessas falhas é um cliente que mandou mensagem e **nunca recebeu resposta nenhuma**.

### Causa 2 — O código apaga a resposta dela antes de enviar

Existem **onze camadas** diferentes no caminho entre o que o modelo escreve e o que o cliente lê. Algumas são corretas e necessárias, como a que impede promessa de contemplação. Mas várias destroem informação útil, e três delas rodam em **toda** resposta, sempre, sem condição:

- **Toda frase que termina com interrogação é apagada.** Não importa qual seja. Se ela explica o consórcio e termina perguntando "quer que eu detalhe o sorteio?", a pergunta desaparece — e com ela o convite para o cliente continuar.
- **O número de frases é cortado para duas** quando o backend vai acrescentar a pergunta dele no fim. Então, se ela escreveu três fatos corretos, o terceiro é jogado fora.
- **Se o que sobrar for vazio**, a resposta inteira é substituída por um texto fixo: "Fico à disposição para qualquer dúvida sobre consórcio." Eu testei isso rodando a função de verdade: uma resposta do modelo que fosse só uma pergunta ("Você prefere um carro novo ou usado?") sai do outro lado como aquele texto genérico. Nada do que ela escreveu chega.

E tem um caso particularmente ruim. Quando o cliente pergunta algo sensível (valor, parcela, taxa), o sistema manda um texto fixo que diz "essa é uma questão específica da operação e precisa ser analisada por um consultor" e, no fim, oferece o horário — exatamente como a regra `R-INF-02` manda. Só que, se esse texto passar pela camada que apaga perguntas, **a oferta de horário é apagada**, porque ela termina com interrogação. O cliente recebe só "precisa ser analisada por um consultor" e ponto. Sem próximo passo. Beco sem saída, que é justamente o que a regra `R-FLOW-11` proíbe.

Juntando os números reais das conversas do snapshot: das cinquenta e cinco respostas que a Mariana te mandou, pelo menos dez (cerca de dezoito por cento) foram **cem por cento texto fixo do backend**, sem nenhuma palavra do modelo. E contando as que tiveram o conteúdo cortado para caber a oferta, chega-se a algo em torno de vinte e sete por cento. Esses números são estimativas, e eu explico por quê na causa 5.

### Causa 3 — O código decide oferecer consultor antes de explicar qualquer coisa

Esta é a sua reclamação número um, e ela tem uma linha de código exata.

A máquina de etapas funciona assim: assim que o campo "objetivo" do lead deixa de estar vazio, a próxima pergunta escolhida é a oferta de consultor. Eu rodei a função para confirmar. Com o cliente tendo dito "quero um carro novo", o resultado é imediatamente `questionKey: "consultantOffer"`. Não existe nenhuma condição de "ela já explicou alguma coisa?" no caminho.

E não é um descuido isolado: o próprio texto de instruções do modelo diz, na seção do fluxo, "**assim que o motivo estiver claro**, ofereça conversar com um consultor". Ou seja, o prompt autoriza exatamente o que a spec proíbe. A regra `R-FLOW-03` diz que a oferta só vem depois de pelo menos uma resposta informativa — e essa condição **não existe em lugar nenhum do sistema**. Não é um bug: é um estado que o sistema não sabe representar.

Pior ainda: o teste `simulation-checks.test.ts` do próprio projeto **aprova** uma conversa que oferece o consultor na segunda mensagem, logo depois de descobrir o objetivo. O teste premia a violação. Enquanto ele estiver assim, a correção vai parecer uma regressão.

Tem uma terceira perna nesse problema, e ela é a mais surpreendente. Eu testei a busca na base de conhecimento, e a pergunta mais comum de todas — um simples "**como funciona?**" — **não encontra nada**. Zero itens. E quando a busca não encontra nada, o sistema injeta no prompt a frase: "Nenhuma evidência autorizada foi encontrada para a pergunta atual. Não afirme o fato comercial e encaminhe a questão ao consultor." Isto é: o código está literalmente mandando ela encaminhar para o consultor na pergunta que ela existe para responder.

A razão é que a busca compara palavras literais, sem entender sinônimos nem variações. "Carro" não casa com "veículo" (a palavra "carro" não aparece em nenhum lugar da base). "Apartamento" não casa com "imóvel". "Comprar" não casa com "compra". E quando alguém pergunta "como funciona o consórcio para carro", o que é devolvido para o modelo são os itens de **imóvel** e de **serviços** — o item de veículos nunca aparece. Ela está explicando carro com material de apartamento.

### Causa 4 — Toques em botão caem num buraco, e ela não tem como saber o estado do agendamento

Aqui são três defeitos que se somam e produzem exatamente o que aconteceu com o Fábio no dia 17.

**Primeiro:** quando o cliente aceita falar com um consultor, o código manda a lista de horários com botões **e, logo em seguida, manda também a pergunta "você tem preferência por algum consultor?" com outros botões**. Dois conjuntos de botões vivos ao mesmo tempo, que é precisamente o que a regra `R-SCH-01` proíbe. E a ordem está invertida em relação à spec, que manda perguntar a preferência primeiro e só depois mostrar os horários.

**Segundo:** o cliente faz o natural — toca num horário, porque foi o que apareceu primeiro. Mas, como a segunda mensagem já avançou a sessão para a etapa "esperando preferência de consultor", o código que trata o toque num horário exige a etapa "esperando escolha de horário", não encontra, e devolve `no_active_session_or_invalid_stage`. E aí vem o ponto crítico: nesse caminho **ele não envia absolutamente nada**. Marca o evento como processado e segue em frente. O cliente tocou no botão e o sistema ficou mudo.

Eu encontrei cerca de **dez saídas silenciosas** como essa nos tratadores de botão: sessão expirada, etapa errada, botão de outra sessão, consultor inativo, consultor sem horário. Em todas, a lógica trata "não posso agir" como "não tenho nada a dizer". A regra `R-SCH-03` é explícita no contrário: nenhum toque em botão fica sem resposta.

**Terceiro:** o toque num botão **nunca é gravado como mensagem** na conversa. Então, além de o sistema não responder, a Mariana nem fica sabendo que o cliente tocou em algo. Para ela, o cliente simplesmente sumiu.

E sobre "ela não sabe o estado do agendamento": isso é literal. Eu listei tudo o que vai para o prompt dela a cada mensagem. A etapa do agendamento, quais horários foram oferecidos, qual horário foi selecionado, quando a sessão expira, a data e a hora da reunião marcada, o nome do consultor — **nada disso é enviado**. O sistema calcula essas informações e não as passa adiante. Durante um agendamento, tudo o que ela recebe é a palavra "scheduling" e a frase "a aplicação apresenta os horários". Quando o cliente pergunta "está confirmada?", ela não tem como saber a resposta, porque ninguém contou para ela.

### Causa 5 — Conversa nenhuma nunca é encerrada, e ninguém está medindo nada

Duas coisas que não existem no sistema.

**A primeira:** a regra `R-SES-02` diz que uma conversa fecha depois de vinte e quatro horas sem mensagem do cliente, e que a próxima começa do zero. Esse fechamento automático **nunca foi construído**. Existem apenas dois processos de fundo no sistema (um para tarefas, um para envio de mensagens) e nenhum deles fecha conversas. O resultado está no snapshot: **trezentas e vinte e nove conversas abertas**, todas paradas há mais de vinte e quatro horas.

A consequência é maior do que parece. Como a conversa nunca fecha, o histórico dela cresce para sempre, e a cada mensagem o sistema reenvia semanas de conversa ao modelo. Pior: a verificação "é o primeiro contato?" e a verificação "essa pergunta já foi feita?" são ambas calculadas por cima desse histórico infinito. Então um cliente que volta depois de uma semana **nunca** é tratado como novo contato, a conversa **nunca** recomeça na saudação, e uma pergunta feita há três semanas continua contando como "já perguntada" hoje. É a sua reclamação número cinco, e a causa é a ausência desse fechamento, não um erro na consulta ao histórico.

Dentro da mesma família está o caso do seu lead. Seu status é `scheduled`, mas a sua única reunião já passou (16 de outubro). Dois defeitos separados produzem isso: a consulta que verifica se existe reunião **olha só o status e nunca a data**, e o status `scheduled` do lead é **terminal** no código — não existe nenhum caminho de volta. Uma vez agendado, sempre agendado. E aí a máquina de etapas fixa a conversa na etapa "confirmação" para sempre. É por isso que ela lembrou da quinta-feira que já tinha passado.

**A segunda coisa que não existe é medição.** Não há um único registro de log em todo o módulo de inteligência artificial nem na função principal que monta a resposta. O texto cru que o modelo escreveu é lido, usado e descartado. A informação de latência, de modelo usado e de consumo de tokens é calculada, devolvida pela função e nunca gravada em lugar nenhum.

Isso tem uma implicação séria: **hoje é impossível saber se a Mariana raciocinou mal ou se nós apagamos o raciocínio dela.** Nenhuma afirmação sobre a qualidade dela, incluindo as deste relatório, pode ser verificada com dados de produção. É por isso que os números da causa 2 são estimativas, e é por isso que a primeira coisa a fazer não é consertar comportamento, e sim passar a enxergar.

---

## 4. O placar contra a sua spec

Avaliei as trinta e oito regras e os quinze cenários da spec:

- **Vinte e três** estão **corretos**.
- **Vinte e dois** estão **violados**.
- **Sete** estão **parcialmente** atendidos.
- **Um** eu não consegui determinar.

Vale registrar o lado bom, que é relevante: as regras de confiabilidade que você mais protege estão sólidas. Mensagem duplicada do WhatsApp não é processada duas vezes. Um envio que pode ter chegado à Meta nunca volta para a fila. Uma mensagem em estado `unknown` nunca é reenviada. Confirmar um horário exige que o identificador seja exatamente igual ao que está gravado no banco. Nada disso está quebrado — e é exatamente por isso que eu recomendo não reescrever a arquitetura.

Os vinte e dois problemas viraram **vinte e oito achados**, classificados assim: **onze P0** (o cliente recebe resposta errada, ou nenhuma, ou há dado corrompido), **nove P1** (experiência ruim), **seis P2** (robustez) e **dois P3** (limpeza).

---

## 5. A arquitetura que eu recomendo

Eu comparei dois caminhos no relatório completo.

**Caminho A:** manter a máquina de etapas determinística que você já tem, mas passar o estado completo para o modelo e parar de mutilar a resposta dele.

**Caminho B:** deixar o modelo conduzir a conversa chamando ferramentas (`pegar_estado`, `oferecer_horarios`, `confirmar_horario`), com o backend validando todo efeito colateral.

**Eu recomendo o caminho A, agora, mas construído de um jeito que deixe o caminho B a um passo de distância.** Três motivos.

O primeiro é o mais importante: **nenhum dos cinco sintomas que você relatou é causado pela arquitetura.** Cada um deles tem um defeito concreto com linha de código. Oferecer antes de explicar é a linha da máquina de etapas somada à contradição no prompt e à busca que não acha nada. Repetir saudações é uma expressão regular frágil que só pega saudação com menos de quarenta caracteres. Ignorar botão é a ordem invertida do agendamento somada às saídas silenciosas. Não saber o estado é o estado ser calculado e não ser passado. Carregar estado antigo é o fechamento por inatividade não existir. Nada disso é prova de que máquina de estados seja a arquitetura errada. É prova de que ela está sendo mal alimentada e que a saída dela está sendo picada.

O segundo motivo: **o caminho B herdaria todos esses problemas.** Um agente conduzido por modelo, montado sobre uma base de conhecimento que não responde "como funciona?", sobre um cálculo de horário comercial com fuso errado e sobre um status de lead do qual não se sai, raciocina igualmente mal — só que mais caro e menos previsível.

O terceiro: **as garantias que importam para o seu negócio são estruturais no caminho A e apenas convencionais no caminho B.** Hoje é impossível, pela forma do código, o modelo inventar um identificador de horário. No caminho B isso passa a depender de cada ferramenta estar escrita corretamente. Com o modelo "lite" atual e sem nenhuma medição, esse risco é incalculável.

O ponto de encontro entre os dois caminhos é uma função única que devolve todo o estado do turno (lead, etapa, sessão de agendamento, reunião marcada, se ela já explicou). No caminho A essa função alimenta o prompt. No caminho B ela **é** a ferramenta `pegar_estado`. Construí-la agora é o que faz o caminho B custar um passo em vez de uma reescrita. Meu palpite sobre o destino final é um híbrido: o modelo conduzindo as etapas de conversa e explicação, e a máquina determinística continuando dona do agendamento.

---

## 6. A ordem dos pacotes de trabalho

Cada pacote é pequeno o bastante para virar um plano sozinho.

1. **Pacote 0 — Enxergar.** Registrar, a cada mensagem, o que o modelo escreveu, o que foi enviado, e qual camada mexeu no texto (gravando apenas tamanhos e impressões digitais, nunca o texto do cliente em produção). Junto, ajustar a configuração do modelo: tirar o nome do código-fonte e colocar em variável de ambiente, definir temperatura baixa, definir limite de resposta e definir orçamento de raciocínio. **Este pacote vem primeiro e não é negociável**, porque sem ele nenhum pacote seguinte pode ser avaliado.
2. **Pacote 1 — Nunca deixar um toque sem resposta.** Uma função única que sempre responde algo quando um botão não pode ser processado, mais gravar o toque como mensagem na conversa. É o maior ganho visível para o cliente.
3. **Pacote 2 — Um só caminho de agendamento.** Preferência primeiro, horários depois. Acaba com os dois conjuntos de botões e com a causa do caso do Fábio.
4. **Pacote 3 — O estado do agendamento passa a ser respondível.** "Falta escolher o horário", "falta confirmar", mais os botões da etapa reenviados.
5. **Pacote 4 — Ciclo de vida da conversa.** Fechar por inatividade, expirar sessões vencidas, criar a conversa dentro de uma transação. Não precisa de mudança de banco e destrava as limpezas de dados.
6. **Pacote 5 — Verdade sobre a reunião.** Consulta que olha a data, caminho de volta a partir de `scheduled`, e os dados da reunião indo para o prompt.
7. **Pacote 6 — Horário comercial de verdade.** Independente dos outros e pequeno (explico no item 7 das perguntas).
8. **Pacote 7 — Parar de mutilar a resposta.** As proteções passam a remover a frase problemática em vez de derrubar a mensagem inteira; a pergunta do modelo é preservada quando o backend não tem pergunta própria.
9. **Pacote 8 — Informar antes de oferecer.** Depende dos pacotes 7 e 10, e a versão definitiva depende de uma mudança de banco (hoje congelada).
10. **Pacote 9 — Afrouxar o filtro de assunto sensível**, com muito cuidado e um teste vermelho por caso.
11. **Pacote 10 — Base de conhecimento que responda "como funciona?"**: sinônimos, radicais de palavra e itens novos no material aprovado.
12. **Pacote 11 — Cirurgia no prompt.** Resolver as onze contradições que eu listei, separar o núcleo fixo da orientação por etapa, limitar o histórico enviado.
13. **Pacote 12 — Rabo de confiabilidade.** Tentar de novo o evento cujo prazo expirou, caminho de modelo aprovado para a janela fechada, e baixar o atraso de resposta de quinze para cinco segundos.
14. **Pacote 13 — Correções de dados no Neon.** Só com a sua autorização explícita, em ramo do Neon com backup, uma por vez.
15. **Pacote 14 — As duas correções travadas pelo congelamento de migrações**, quando a base aprovada existir.
16. **Pacote 15 — Higiene da spec**, incluindo a decisão de identidade.

Um detalhe sobre velocidade, que vale saber antes de culpar o modelo: hoje, do momento em que o cliente manda a última mensagem até a resposta chegar, passam entre **vinte e vinte e três segundos**. Quinze deles são o tempo de espera proposital para juntar mensagens seguidas, e o resto são os intervalos dos processos de fundo e a chamada ao modelo. Isso significa que o argumento "o modelo mais forte é mais lento" não se sustenta: um ou dois segundos a mais de raciocínio seriam invisíveis dentro desses vinte. O que faz a Mariana parecer lenta é a espera, não o modelo.

---

## 7. O que eu preciso decidir com você

1. **A spec.** Posso recomendar que você mova o `MARIANA_BEHAVIOR_SPEC.md` para `docs/specs/MARIANA_BEHAVIOR_SPEC.md` e o commite? Hoje ele está na raiz e sem rastreamento pelo Git, o que faz os agentes não o encontrarem e deixa a régua do projeto exposta a ser perdida.
2. **O modelo.** Qual caminho você prefere: manter o modelo "lite" mas ligar o raciocínio e baixar a temperatura (mudança só de configuração, o mais barato), ou subir para o nível intermediário `gemini-3.5-flash` com raciocínio ligado? Minha recomendação é testar o primeiro, medir com o registro do pacote 0, e subir para o segundo se os registros ainda mostrarem raciocínio fraco. Os dois aumentam o custo; as estimativas estão na seção 2.1.3 do relatório.
3. **A identidade.** Esta é uma operação **Ademicon** ou uma operação sem marca? Hoje a base de conhecimento é inteira da Ademicon, o prompt manda ela negar vínculo com qualquer administradora, e a busca esconde todos os itens da Ademicon quando nenhuma empresa está configurada. As três coisas não podem estar certas ao mesmo tempo, e isso deixa metade do material inalcançável.
4. **A regra de informar antes de oferecer.** O que exatamente conta como "pelo menos uma resposta informativa"? Uma mensagem que usou material aprovado? Uma mensagem na etapa de informação? Eu preciso de uma definição que possa ser testada antes de planejar o pacote 8.
5. **O que ela pode responder sem encaminhar.** A Mariana pode responder, com material aprovado e sem mandar para o consultor, estas três coisas: a duração da reunião (trinta minutos, que já está escrita no prompt dela), o formato (Google Meet) e uma comparação genérica entre consórcio e financiamento? Hoje as três caem no filtro de assunto sensível e viram encaminhamento, o que é um encaminhamento desnecessário e deixa o cliente sem resposta.
6. **A espera de quinze segundos.** Posso propor baixar para cinco segundos, que é o número que a sua própria spec usa no cenário `S-12`? Isso aproximadamente dobra o número de chamadas ao modelo, mas corta dois terços do tempo de espera percebido pelo cliente.
7. **O fuso horário dos horários oferecidos.** Encontrei um defeito que você provavelmente não notou: o cálculo do horário comercial (das oito às dezoito) usa o fuso do servidor, não o de São Paulo, enquanto todo o resto do sistema usa São Paulo. Se o servidor roda em UTC, isso significa que os horários oferecidos são das cinco da manhã às três da tarde no horário de Brasília. Eu recomendo corrigir, mas quero que você confirme, porque isso muda quais horários os clientes passam a ver.
8. **As correções de dados.** Você aprova, em princípio, as propostas da seção 5 do relatório — fechar as conversas paradas, expirar as sessões vencidas, recalcular o seu status de lead, limpar os dados de teste? Elas seriam executadas depois, uma por vez, cada uma em ramo do Neon com backup antes, e com a lista exata de registros revisada por você. **Nada foi executado.** Tudo está escrito como proposta revisável.
9. **O congelamento de migrações.** Duas correções precisam de mudança no banco: a garantia no próprio banco de uma só conversa ativa por lead, e o campo que registra se ela já explicou algo. As duas estão travadas pelo congelamento. Você prefere esperar a base aprovada, ou prefere priorizar essa base para que elas possam entrar?
10. **A ordem no agendamento.** A spec manda perguntar a preferência de consultor antes de mostrar os horários; o código faz o contrário. Confirma que preferência-primeiro é a ordem que você quer? É com base nessa confirmação que eu planejo o pacote 2.
11. **O que fazer depois da reunião marcada.** A spec diz que, com reunião futura marcada, a Mariana continua ajudando e não encerra a conversa a cada mensagem. O prompt dela diz o contrário: encerrar o atendimento depois do agendamento. Pela sua própria regra, a spec vence — mas eu quero sua confirmação, porque isso muda o comportamento dela depois do agendamento.

---

## 8. Pedido de autorização

Davi, esta auditoria terminou. Ela só leu o código, as suas evidências de produção e a sua spec, e produziu dois documentos: o relatório técnico completo, com evidência linha por linha, e esta explicação.

**Eu peço a sua permissão para usar esta auditoria como base dos próximos planos de trabalho.** Concretamente, peço autorização para:

- tratar o `MARIANA_BEHAVIOR_SPEC.md` na versão 1.0 como a régua oficial dos próximos planos;
- transformar os pacotes da seção 6 em planos, um a um, começando pelo pacote 0 (enxergar e configurar o modelo), que não muda comportamento nenhum e é o que torna todo o resto mensurável;
- registrar os onze achados P0 como a fila de prioridade, na ordem que você aprovar.

Nada será implementado antes da sua autorização, e nenhuma correção de dados será executada sem a sua aprovação explícita, com backup do Neon antes, caso a caso. Nenhum commit será feito sem você pedir.

Se você preferir responder só as decisões mais urgentes, as que destravam mais trabalho são a número 2 (o modelo), a número 4 (a definição de "informar antes de oferecer") e a número 10 (a ordem do agendamento). Com essas três eu já consigo escrever os três primeiros planos.
