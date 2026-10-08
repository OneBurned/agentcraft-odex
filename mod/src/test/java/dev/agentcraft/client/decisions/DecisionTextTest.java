package dev.agentcraft.client.decisions;

import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.ui.TextUtil;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class DecisionTextTest {
    private Protocol.Decision question(String agent, String question, String context) {
        return new Protocol.Decision("d1", agent, Protocol.DecisionKind.QUESTION, question, List.of("Продолжить"),
            context, Protocol.DecisionStatus.OPEN, null, "t1", null, null, "role-queue", 1);
    }
    @Test public void retainsLongQuestionsAndRecoveryContextForEveryAgent() {
        String text = "Начало\n\n" + "Подробное замечание по задаче.\n".repeat(100) + "КОНЕЦ ВОПРОСА";
        String context = "Причина отклонения ответа\n" + "Проверить состояние.\n".repeat(30) + "КОНЕЦ ПОЯСНЕНИЯ";
        for (String agent : List.of("marlow", "wren", "agent_third")) {
            assertEquals(text + "\n\n" + context, DecisionText.content(question(agent, text, context)));
            assertEquals(text, DecisionText.content(question(agent, text, null)));
            assertEquals(text, DecisionText.content(question(agent, text, text)));
        }
    }
    @Test public void scrollingCanReachTheLastQuestionLineAndStayThereAcrossFrames() {
        var scroll = new TextUtil.Scroll();
        scroll.update(150, 4); scroll.toTop();
        assertEquals(0, scroll.offset());
        for (int n = 0; n < 60; n++) scroll.scrollBy(3);
        assertEquals(146, scroll.offset());
        scroll.update(150, 4); assertEquals(146, scroll.offset());
        scroll.scrollBy(-3); assertEquals(143, scroll.offset());
    }
}
