package dev.agentcraft.command;

import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

/**
 * The {@code /agentcraft} command root. Features add their own sub-commands with
 * {@link #sub(Consumer)} from their {@code init()}, so nobody has to edit this file:
 * <pre>
 * AgentCraftCommands.sub(root -> root.then(Commands.literal("preview").executes(ctx -> ...)));
 * </pre>
 * Built in: the bare root and {@code /agentcraft help} show the supported player commands.
 */
public final class AgentCraftCommands {
	private static final List<Consumer<LiteralArgumentBuilder<CommandSourceStack>>> SUBS = new CopyOnWriteArrayList<>();

	private AgentCraftCommands() {
	}

	public static void sub(Consumer<LiteralArgumentBuilder<CommandSourceStack>> contributor) {
		SUBS.add(contributor);
	}

	public static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, buildContext, selection) -> {
			LiteralArgumentBuilder<CommandSourceStack> root = Commands.literal("agentcraft")
				.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
				.executes(ctx -> help(ctx.getSource()))
				.then(Commands.literal("help").executes(ctx -> help(ctx.getSource())));
			for (var s : SUBS) {
				s.accept(root);
			}
			dispatcher.register(root);
		});
	}

	private static int help(CommandSourceStack source) {
		for (String line : List.of(
			"AgentCraft — постройки и рабочие места",
			"/agentcraft preview <постройка> — показать границы на 15 секунд.",
			"/agentcraft place <постройка> — построить вокруг блока под прицелом.",
			"studio — большая студия, участок 93×91; cabin — домик, участок 27×27.",
			"Схемы из config/agentcraft/buildings также доступны по имени файла без .schem; Tab покажет варианты.",
			"Наведи прицел на блок не дальше 64 блоков. Постройка расчистит участок: сначала проверь preview.",
			"Рабочие места назначай Настройщиком и в пульте. Задачи и сообщения — в консоли AgentCraft.")) {
			source.sendSuccess(() -> Component.literal(line), false);
		}
		return 1;
	}
}
