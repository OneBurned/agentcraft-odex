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
import static dev.agentcraft.client.studio.TeamDraft.*;

/** Team editor keeps unsaved fields until a confirmed mutation and never executes agent work. */
public final class TeamAgentScreen extends Screen {
    private final StudioScreen parent;
    private JsonObject data, agent;
    private TeamDraft draft;
    private String id, status = "", savedName, savedTransport;
    private java.util.Set<String> savedRoles;
    private boolean busy, confirmClose, confirmArchive, connectionLoaded;
    private int page;
    private TeamDraft.Layout bounds;
    public TeamAgentScreen(StudioScreen parent, JsonObject data, JsonObject agent) {
        super(Component.literal("Настройка агента")); this.parent = parent; this.data = data.deepCopy(); this.agent = agent.deepCopy(); id = text(agent, "id");
        resetDraft("");
    }
    private void resetDraft(String transport) {
        draft = new TeamDraft(data.getAsJsonArray("capabilities"), agent, transport);
        savedName = draft.name; savedTransport = draft.transport; savedRoles = new java.util.HashSet<>(draft.roles); confirmClose = false;
    }
    private boolean dirty() { return !savedName.equals(draft.name) || !savedTransport.equals(draft.transport) || !savedRoles.equals(draft.roles); }
    private void requireSaved() { if (dirty()) throw new IllegalStateException("Сначала сохрани профиль или перечитай настройки."); }
    @Override public boolean isPauseScreen() { return false; }
    @Override public void extractBackground(GuiGraphicsExtractor g, int mx, int my, float dt) {}
    @Override protected void init() {
        layout();
        if (!id.isEmpty() && !connectionLoaded && !busy) readTransport();
    }
    private void readTransport() {
        var p = new JsonObject(); p.addProperty("id", id);
        call("connection.get", p, result -> {
            connectionLoaded = true;
            if (!dirty() && result.has("connection") && result.get("connection").isJsonObject()) resetDraft(text(result.getAsJsonObject("connection"), "transport"));
        });
    }
    private Button button(String label, int x, int y, int w, Runnable action) {
        var b = addRenderableWidget(Button.builder(Component.literal(TextUtil.ellipsize(font, label, w - 8)), p -> { try { action.run(); } catch (Exception e) { status = e.getMessage(); } })
            .bounds(x, y, w, 20).tooltip(Tooltip.create(Component.literal(label))).build()); b.active = !busy; return b;
    }
    private void layout() {
        clearWidgets(); bounds = TeamDraft.Layout.at(width, height); int x = bounds.x(), w = bounds.width(), y = bounds.contentY();
        String[] tabs = {"Профиль", "Подключение", "Действия"};
        for (int i = 0; i < tabs.length; i++) { final int n = i; button(tabs[i], x + i * (w / 3), 34, w / 3 - 3, () -> { page = n; layout(); }); }
        boolean archived = flag(agent, "archived");
        if (page == 0) {
            var name = addRenderableWidget(new EditBox(font, x, y, w, 20, Component.literal("Имя агента"))); name.setMaxLength(28); name.setValue(draft.name);
            name.setResponder(v -> { draft.name = v; confirmClose = false; }); name.active = !busy && !archived;
            button("Подключение: " + text(draft.capability(), "title"), x, y + 24, w, () -> { draft.nextTransport(); status = "При смене провайдера прежнее подключение будет отсоединено."; layout(); }).active = !busy && !archived;
            for (int i = 0; i < ROLES.length; i++) {
                String role = ROLES[i], label = (draft.roles.contains(role) ? "✓ " : "") + roleName(role);
                var b = button(label, x + i * (w / 3), y + 48, w / 3 - 3, () -> { if (!draft.roles.remove(role)) draft.roles.add(role); layout(); });
                b.active = !busy && !archived && (draft.supports(role) || draft.roles.contains(role));
                if (!draft.supports(role)) b.setTooltip(Tooltip.create(Component.literal(draft.reason(role))));
            }
            button(id.isEmpty() ? "Создать агента" : "Сохранить профиль", x, y + 76, w, this::save).active = !busy && !archived;
        } else if (page == 1) {
            button("Настроить подключение…", x, y, w, () -> {
                if (dirty()) throw new IllegalStateException("Сначала сохрани профиль агента.");
                minecraft.gui.setScreen(new TeamConnectionScreen(this, id, draft.transport));
            }).active = !busy && !id.isEmpty() && !archived;
            button("Включён: " + (flag(agent, "enabled") ? "да" : "нет"), x, y + 24, w, () -> update("enabled", !flag(agent, "enabled"))).active = !busy && !id.isEmpty() && !archived;
            button("Карточка: сообщение, пауза, стоп…", x, y + 48, w, () -> { requireSaved(); minecraft.gui.setScreen(new dev.agentcraft.client.agents.AgentCardScreen(id)); }).active = !busy && !id.isEmpty() && !archived;
            button("Обновить состояние", x, y + 76, w, this::refresh);
        } else {
            int half = (w - 4) / 2;
            button("Внешность / PNG", x, y, half, () -> { requireSaved(); parent.openAgentTab(id, 1); }).active = !busy && !id.isEmpty() && !archived;
            button("Характер и фразы", x + half + 4, y, half, () -> minecraft.gui.setScreen(new PersonaScreen(this, id, text(agent, "name")))).active = !busy && !id.isEmpty() && !archived;
            button("Места агента", x, y + 24, half, () -> { requireSaved(); parent.openAgentTab(id, 4); }).active = !busy && !id.isEmpty() && !archived;
            button("В мире: " + (flag(agent, "visible") ? "виден" : "скрыт"), x + half + 4, y + 24, half, () -> update("visible", !flag(agent, "visible"))).active = !busy && !id.isEmpty() && !archived;
            button(archived ? "Восстановить (выключенным)" : confirmArchive ? "Подтвердить перенос в архив" : "Убрать в архив", x, y + 48, w, () -> {
                requireSaved();
                if (!archived && !confirmArchive) { confirmArchive = true; status = "Архив скроет и выключит агента. История и настройки сохранятся."; layout(); return; }
                call(archived ? "team.restore" : "team.archive", selected(), result -> { confirmArchive = false; refresh(); });
            }).active = !busy && !id.isEmpty();
            button("Перечитать сохранённые настройки", x, y + 76, w, this::refresh);
        }
        button(confirmClose ? "Закрыть без сохранения" : "Назад", x, bounds.backY(), w, this::onClose);
    }
    private JsonObject selected() { var p = new JsonObject(); p.addProperty("id", id); p.add("revision", data.getAsJsonObject("team").get("revision")); return p; }
    private void update(String field, boolean value) {
        if (dirty()) throw new IllegalStateException("Сначала сохрани профиль или перечитай настройки.");
        var p = selected(); var patch = new JsonObject(); patch.addProperty(field, value); p.add("patch", patch);
        call("team.update", p, result -> refresh());
    }
    private void save() {
        var payload = draft.payload(data.getAsJsonObject("team").get("revision").getAsInt());
        String transport = draft.transport;
        call(id.isEmpty() ? "team.create" : "team.update", payload, result -> {
            if (id.isEmpty()) { var agents = result.getAsJsonArray("agents"); id = text(agents.get(agents.size() - 1).getAsJsonObject(), "id"); }
            status = "Профиль сохранён. Настрой подключение и включи агента.";
            refresh(transport);
        });
    }
    void refresh() { refresh(""); }
    private void refresh(String transport) {
        call("get", new JsonObject(), result -> {
            data = result;
            for (var v : data.getAsJsonObject("team").getAsJsonArray("agents")) if (text(v.getAsJsonObject(), "id").equals(id)) agent = v.getAsJsonObject();
            resetDraft(transport); parent.acceptTeamData(data);
            if (transport.isEmpty() && !id.isEmpty()) readTransport();
        });
    }
    void call(String action, JsonObject payload, Consumer<JsonObject> success) {
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
        if (dirty() && !confirmClose) { confirmClose = true; status = "Профиль не сохранён. Повторное нажатие закроет редактор."; layout(); return; }
        parent.acceptTeamData(data); minecraft.gui.setScreen(parent);
    }
    @Override public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float dt) {
        g.fill(0, 0, width, height, 0xF2292722);
        g.text(font, TextUtil.ellipsize(font, title.getString() + (id.isEmpty() ? " · новый" : " · " + text(agent, "name")), bounds.width()), bounds.x(), 14, 0xFFF2EAD8);
        String hint = page == 0 ? text(draft.capability(), "hint") : page == 1 ? "Управление агентом отдельно от очереди. Проверка не запускает задачу." : "Архив сохраняет ID, память, историю и места агента.";
        g.text(font, TextUtil.ellipsize(font, hint, bounds.width()), bounds.x(), bounds.contentY() + 103, 0xFFD5CEC0);
        if (my >= bounds.contentY() + 100 && my < bounds.backY()) g.setTooltipForNextFrame(font, Component.literal(hint), mx, my);
        var lines = TextUtil.wrapPlain(font, status == null ? "" : status, bounds.width());
        for (int i = 0; i < Math.min(2, lines.size()); i++) g.text(font, TextUtil.ellipsize(font, lines.get(i), bounds.width()), bounds.x(), bounds.statusY() + 10 * i, 0xFFDFC185);
        super.extractRenderState(g, mx, my, dt);
        if (my >= bounds.statusY() && !status.isEmpty()) g.setTooltipForNextFrame(font, Component.literal(status), mx, my);
    }
}
