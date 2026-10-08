package dev.agentcraft.client.studio;

import com.google.gson.*;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.ui.TextUtil;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.*;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import java.util.function.Consumer;
import static dev.agentcraft.client.studio.TeamDraft.text;

/** One field per page fits normal Minecraft GUI scales and retains failed saves. */
public final class TeamConnectionScreen extends Screen {
    private final TeamAgentScreen parent;
    private final String id, transport;
    private ConnectionDraft draft;
    private int revision, page;
    private boolean busy, confirmClose, loaded;
    private String status = "Загружаю подключение…";
    private TeamDraft.Layout bounds;
    public TeamConnectionScreen(TeamAgentScreen parent, String id, String transport) { super(Component.literal("Подключение агента")); this.parent = parent; this.id = id; this.transport = transport; }
    @Override public boolean isPauseScreen() { return false; }
    @Override public void extractBackground(GuiGraphicsExtractor g, int mx, int my, float dt) {}
    @Override protected void init() { layout(); if (!loaded && !busy) load(); }
    private JsonObject selected() { var p = new JsonObject(); p.addProperty("id", id); return p; }
    private void load() {
        send("team.get", new JsonObject(), team -> { revision = team.get("revision").getAsInt();
            send("connection.get", selected(), result -> {
                var c = result.has("connection") && result.get("connection").isJsonObject() ? result.getAsJsonObject("connection") : new JsonObject();
                draft = new ConnectionDraft(transport, c); loaded = true; confirmClose = false;
                status = text(result, "notice") + ". Проверка не запускает задачу.";
            });
        });
    }
    private Button button(String label, int x, int y, int w, Runnable action) {
        var b = addRenderableWidget(Button.builder(Component.literal(TextUtil.ellipsize(font, label, w - 8)), p -> { try { action.run(); } catch (Exception e) { status = e.getMessage(); } })
            .bounds(x, y, w, 20).tooltip(Tooltip.create(Component.literal(label))).build()); b.active = !busy; return b;
    }
    private void layout() {
        clearWidgets(); bounds = TeamDraft.Layout.at(width, height); int x = bounds.x(), w = bounds.width(), y = bounds.contentY(), third = (w - 8) / 3;
        if (draft != null) {
            button("←", x, 34, 26, () -> { page = Math.floorMod(page - 1, draft.keys.length); layout(); });
            button((page + 1) + "/" + draft.keys.length + " · " + draft.labels[page], x + 30, 34, w - 60, () -> { page = (page + 1) % draft.keys.length; layout(); });
            button("→", x + w - 26, 34, 26, () -> { page = (page + 1) % draft.keys.length; layout(); });
            var field = addRenderableWidget(new EditBox(font, x, y, w, 20, Component.literal(draft.labels[page]))); field.setMaxLength(4000); field.setValue(draft.values.get(draft.keys[page]));
            final String key = draft.keys[page]; field.setResponder(v -> { draft.values.put(key, v); confirmClose = false; }); field.active = !busy;
            button("Сохранить", x, y + 28, third, () -> send("connection.bind", draft.payload(id, revision), result -> {
                revision = result.getAsJsonObject("team").get("revision").getAsInt(); draft.markSaved(); status = "Подключение сохранено. Теперь проверь его.";
            }));
            button("Проверить", x + third + 4, y + 28, third, () -> {
                if (!draft.canCheck()) throw new IllegalStateException("Сначала сохрани выбранное подключение.");
                send("connection.check", selected(), result -> {
                    JsonObject r = result.getAsJsonObject("result"); String notice = text(r, "notice");
                    status = (notice.isEmpty() ? "CLI и вход проверены. Версия: " + text(r, "version") : notice) + " " + text(r, "developer");
                });
            });
            button("Перечитать", x + 2 * (third + 4), y + 28, w - 2 * (third + 4), () -> {
                if (draft.dirty() && !confirmClose) { confirmClose = true; status = "Повтори «Перечитать», чтобы сбросить несохранённые поля."; layout(); } else load();
            });
            if (transport.equals("codex-desktop")) button("Импортировать имеющееся подключение Codex", x, y + 56, w, () -> {
                var p = selected(); p.addProperty("revision", revision);
                send("connection.importCodex", p, result -> load());
            });
        } else button("Повторить загрузку", x, y, w, this::load);
        button(confirmClose ? "Закрыть без сохранения" : "Назад", x, bounds.backY(), w, this::onClose);
    }
    private void send(String action, JsonObject payload, Consumer<JsonObject> success) {
        if (busy) return;
        if (!Foreman.connected()) { status = "Нет связи с мостом. Поля сохранены на экране."; return; }
        busy = true; layout(); var msg = new JsonObject(); msg.addProperty("action", action); msg.add("payload", payload);
        Foreman.send("studio.action", msg).whenComplete((ack, error) -> Minecraft.getInstance().execute(() -> {
            busy = false;
            if (error != null || !ack.ok()) status = error != null ? "Нет подтверждения. Перечитай состояние перед повтором." : ack.error();
            else { try { success.accept(ack.result()); } catch (Exception e) { status = e.getMessage(); } }
            if (minecraft.gui.screen() == this) layout();
        }));
    }
    @Override public void onClose() {
        if (busy) return;
        if (draft != null && draft.dirty() && !confirmClose) { confirmClose = true; status = "Поля не сохранены. Нажми «Назад» ещё раз, чтобы закрыть."; layout(); return; }
        minecraft.gui.setScreen(parent); parent.refresh();
    }
    @Override public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float dt) {
        g.fill(0, 0, width, height, 0xF2292722); g.text(font, title, bounds.x(), 14, 0xFFF2EAD8);
        String hint = transport.equals("claude-code") ? "Нужно подготовленное пространство с access.json и conversation.json." : transport.equals("codex-cli") ? "Разработка требует workspace-write. Ревью — read-only. Нужен вход в Codex CLI." : "Для второго агента укажи отдельный чат. Один чат принадлежит одному агенту.";
        g.text(font, TextUtil.ellipsize(font, hint, bounds.width()), bounds.x(), bounds.contentY() + 88, 0xFFD5CEC0);
        if (my >= bounds.contentY() + 84 && my < bounds.backY()) g.setTooltipForNextFrame(font, Component.literal(hint), mx, my);
        var lines = TextUtil.wrapPlain(font, status == null ? "" : status, bounds.width());
        for (int i = 0; i < Math.min(2, lines.size()); i++) g.text(font, TextUtil.ellipsize(font, lines.get(i), bounds.width()), bounds.x(), bounds.statusY() + 10 * i, 0xFFDFC185);
        super.extractRenderState(g, mx, my, dt);
        if (my >= bounds.statusY() && !status.isEmpty()) g.setTooltipForNextFrame(font, Component.literal(status), mx, my);
    }
}
