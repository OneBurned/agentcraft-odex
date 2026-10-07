package dev.agentcraft.client.agents;

import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.AgentControls;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.List;

public class AgentCardInputTest {
    @Test public void acceptsRealMinecraft263LeftClickNotLegacyZeroOrRightClick() {
        // SDL/Minecraft 26.3 reports button 1 for the left mouse button.
        assertTrue(AgentCardInput.primaryClick(new MouseButtonEvent(100, 80, new MouseButtonInfo(1, 0))));
        assertFalse(AgentCardInput.primaryClick(new MouseButtonEvent(100, 80, new MouseButtonInfo(0, 0))));
        assertFalse(AgentCardInput.primaryClick(new MouseButtonEvent(100, 80, new MouseButtonInfo(3, 0))));
    }

    @Test public void aLiveControlChangeImmediatelyBlocksMessageAndPreservesItsReason() {
        var available = new AgentControls(true, false, false, false, "Можно отправить сообщение");
        var external = new AgentControls(false, false, false, false, "Клава открыта в терминале. Верни разговор в игру");
        assertNull(AgentCardInput.messageError(true, false, true, available, false));
        assertEquals(external.hint(), AgentCardInput.messageError(true, false, true, external, false));
        assertNotNull(AgentCardInput.messageError(true, false, true, null, false));
        assertNull(AgentCardInput.messageError(true, false, false, null, false)); // non-observer backend
        assertNull(AgentCardInput.messageError(true, false, true, available, false));
    }

    @Test public void answeringAnOpenDecisionIsIndependentOfConversationPermissionButStillNeedsConnection() {
        var waiting = new AgentControls(false, false, false, false, "Агент занят");
        assertNull(AgentCardInput.messageError(true, false, true, waiting, true));
        assertNotNull(AgentCardInput.messageError(false, false, true, waiting, true));
        assertNotNull(AgentCardInput.messageError(true, true, true, waiting, true));
        assertNotNull(AgentCardInput.messageError(true, false, true, waiting, false));
    }

    private Protocol.Decision question(String tool) {
        return new Protocol.Decision("d2", "wren", Protocol.DecisionKind.QUESTION, "Как продолжить?",
            List.of("Продолжить с ответом", "Отменить задачу"), null, Protocol.DecisionStatus.OPEN,
            null, "t33", null, null, tool, 2);
    }

    @Test public void continueRequiresTextWhileCancelAndOrdinaryChoicesDoNot() {
        var decision = question("studio");
        assertTrue(decision.requiresText("Продолжить с ответом"));
        assertFalse(decision.requiresText("Отменить задачу"));
        assertFalse(decision.requiresText(null));
        assertFalse(question(null).requiresText("Продолжить с ответом"));
        assertTrue(decision.requiresText(Protocol.REQUEST_CHANGES));
    }
}
