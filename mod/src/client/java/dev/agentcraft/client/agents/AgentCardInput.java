package dev.agentcraft.client.agents;

import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.foreman.Protocol.AgentControls;
import net.minecraft.client.input.MouseButtonEvent;
import org.jspecify.annotations.Nullable;

/** Input policy shared by drawing and activation of the character card. */
public final class AgentCardInput {
    private AgentCardInput() {}

    public static boolean primaryClick(MouseButtonEvent event) {
        return event.button() == InputConstants.MOUSE_BUTTON_LEFT;
    }

    public static @Nullable String messageError(boolean live, boolean sending, boolean observer,
            @Nullable AgentControls controls, boolean answering) {
        if (!live) return "Нет связи с мостом. Дождись подключения";
        if (sending) return "Ожидаю подтверждение отправки…";
        // Answering a decision is distinct from starting a new conversation with a busy agent.
        if (answering || !observer) return null;
        if (controls == null) return "Ожидаю состояние управления агентом…";
        if (controls.message()) return null;
        return controls.hint() == null || controls.hint().isBlank()
            ? "Сообщение сейчас недоступно. Проверь состояние агента в пульте" : controls.hint();
    }
}
