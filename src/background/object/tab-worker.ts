import { browser } from 'webextension-polyfill-ts';

import { BrowserAction } from '@/background/browser/browser-action';
import { Controller, ControllerEvent } from '@/background/object/controller';

import {
	isActiveMode,
	isInactiveMode,
} from '@/background/object/controller-mode';
import { ConnectorEntry } from '@/common/connector-entry';
import { getCurrentTab } from '@/common/util-browser';
import { getConnectorByUrl } from '@/common/util-connector';
import {
	InjectResult,
	injectConnector,
} from '@/background/browser/inject-connector';
import {
	isConnectorEnabled,
	setConnectorEnabled,
} from '@/background/storage/options';
import { L } from '@/common/i18n';
import {
	Event,
	MessageType,
	Request,
	ToggleLoveResponse,
	sendMessageToAll,
	sendMessageToContentScripts,
	CorrectTrackResponse,
} from '@/common/messages';
import { ParsedSongInfo, LoveStatus } from '@/background/object/song';

export abstract class TabWorker {
	private activeTabId: number = browser.tabs.TAB_ID_NONE;
	private currentTabId: number = browser.tabs.TAB_ID_NONE;

	private tabControllers: Record<number, Controller> = {};
	private browserAction: BrowserAction;

	constructor() {
		this.initialize();
	}

	/**
	 * Called if a new event is dispatched.
	 *
	 * @param ctrl Controller instance
	 * @param event Event generated by the controller.
	 */
	abstract onControllerEvent(ctrl: Controller, event: ControllerEvent): void;

	/**
	 * Returna an ID of the current tab.
	 *
	 * @return Tab ID
	 */
	getActiveTabId(): number {
		return this.activeTabId;
	}

	/**
	 * Called when a command is executed.
	 *
	 * @param command Command ID
	 */
	async processCommand(command: string): Promise<void> {
		const ctrl =
			this.tabControllers[this.activeTabId] ||
			this.tabControllers[this.currentTabId];
		if (!ctrl) {
			return;
		}

		switch (command) {
			case 'toggle-connector':
				this.setConnectorState(ctrl, !ctrl.isEnabled);
				break;

			case 'love-song':
			case 'unlove-song': {
				const loveStatus =
					command === 'love-song'
						? LoveStatus.Loved
						: LoveStatus.Unloved;

				await ctrl.toggleLove(loveStatus);
				this.browserAction.setSongLoved(
					loveStatus,
					ctrl.getCurrentSong()
				);
				break;
			}
		}
	}

	/**
	 * Called when something sent message to the background script
	 * via `browser.runtime.sendMessage` function.
	 *
	 * @param tabId ID of a tab to which the message is addressed
	 * @param type Message type
	 * @param data Object contains data sent in the message
	 */
	async processMessage(
		tabId: number,
		type: MessageType,
		data: unknown
	): Promise<unknown> {
		const ctrl = this.tabControllers[tabId];

		if (!ctrl) {
			console.warn(
				`Attempted to send ${type} event to controller for tab ${tabId}`
			);
			return;
		}

		switch (type) {
			case Request.GetTrack:
				return ctrl.getCurrentSong().getCloneableData();

			case Request.GetConnectorLabel:
				return ctrl.getConnector().label;

			case Request.CorrectTrack: {
				const { track } = data as CorrectTrackResponse;
				ctrl.setUserSongData(track);
				break;
			}

			case Request.ToggleLove: {
				const { loveStatus } = data as ToggleLoveResponse;
				await ctrl.toggleLove(loveStatus);
				break;
			}

			case Request.SkipTrack:
				ctrl.skipCurrentSong();
				break;

			case Request.ResetTrack:
				ctrl.resetSongData();
				break;
		}
	}

	/**
	 * Called when something sent message to the background script via port.
	 *
	 * @param tabId ID of a tab to which the message is addressed
	 * @param type Message type
	 * @param data Object contains data sent in the message
	 */
	processPortMessage(tabId: number, type: MessageType, data: unknown): void {
		switch (type) {
			case Event.StateChanged: {
				const ctrl = this.tabControllers[tabId];
				if (ctrl) {
					ctrl.onStateChanged(data as ParsedSongInfo);
				}
				break;
			}
		}
	}

	/**
	 * Called when a tab is updated.
	 *
	 * @param tabId Tab ID
	 * @param url Object contains changes of updated tab
	 */
	async processTabUpdate(tabId: number, url: string): Promise<void> {
		const connector = await getConnectorByUrl(url);
		await this.tryToInjectConnector(tabId, connector);
	}

	/**
	 * Called when a current tab is changed.
	 *
	 * @param tabId Tab ID
	 */
	processTabChange(tabId: number): void {
		this.currentTabId = tabId;

		if (this.shouldUpdateBrowserAction(tabId)) {
			this.updateBrowserAction(tabId);
			this.activeTabId = tabId;
		}

		this.updateContextMenu(tabId);
	}

	/**
	 * Called when a tab is removed.
	 *
	 * @param removedTabId Tab ID
	 */
	processTabRemove(removedTabId: number): void {
		this.unloadController(removedTabId);

		if (removedTabId === this.activeTabId) {
			this.activeTabId = browser.tabs.TAB_ID_NONE;
			this.updateLastActiveTab();
		}
	}

	private async initialize(): Promise<void> {
		const currentTab = await getCurrentTab();
		// We cannot get a current tab in some cases on startup
		if (currentTab) {
			this.currentTabId = currentTab.id;
		}

		this.browserAction = new BrowserAction();
		/*
		 * Prevent restoring the browser action icon
		 * from the previous session.
		 */
		this.browserAction.reset();
	}

	/**
	 * Update the browser action in context of a given tab ID.
	 *
	 * @param tabId Tab ID
	 */
	private updateBrowserAction(tabId: number): void {
		const ctrl = this.tabControllers[tabId];
		if (ctrl) {
			this.browserAction.update(ctrl);
		} else {
			this.browserAction.reset();
		}
	}

	/**
	 * Check if the browser action should be updated
	 * in context of a given tab ID.
	 *
	 * @param tabId Tab ID
	 *
	 * @return Check result
	 */
	private shouldUpdateBrowserAction(tabId: number): boolean {
		const activeCtrl = this.tabControllers[this.activeTabId];
		if (activeCtrl && isActiveMode(activeCtrl.mode)) {
			return false;
		}

		const ctrl = this.tabControllers[tabId];
		if (ctrl) {
			if (tabId !== this.currentTabId && isInactiveMode(ctrl.mode)) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Get ID of a tab with recent active controller.
	 *
	 * @return Tab ID
	 */
	private findActiveTabId(): number {
		const ctrl = this.tabControllers[this.currentTabId];
		if (ctrl && isActiveMode(ctrl.mode)) {
			return this.currentTabId;
		}

		for (const tabId in this.tabControllers) {
			const ctrl = this.tabControllers[tabId];
			const mode = ctrl.getMode();
			if (isActiveMode(mode)) {
				// NOTE: Don't use `tabId` directly, it's a string.
				return ctrl.tabId;
			}
		}

		if (ctrl) {
			return this.currentTabId;
		}

		return browser.tabs.TAB_ID_NONE;
	}

	/**
	 * Update the browser action and the context menu in context of a last
	 * active tab. If no active tab is found, reset the browser action icon
	 * and the context menu.
	 */
	private updateLastActiveTab(): void {
		const lastActiveTabId = this.findActiveTabId();
		if (lastActiveTabId !== browser.tabs.TAB_ID_NONE) {
			this.activeTabId = lastActiveTabId;

			this.updateBrowserAction(this.activeTabId);
			this.updateContextMenu(this.activeTabId);
		} else {
			this.browserAction.reset();
			this.resetContextMenu();
		}
	}

	/**
	 * Setup context menu of the browser action for a tab with given tab ID.
	 *
	 * @param tabId Tab ID
	 */
	private updateContextMenu(tabId: number): void {
		this.resetContextMenu();

		const ctrl = this.tabControllers[tabId];

		// Always display context menu for current tab
		if (ctrl) {
			this.addToggleConnectorMenu(tabId, ctrl);
			if (ctrl.isEnabled) {
				this.addDisableUntilTabClosedItem(tabId, ctrl);
			}
		}

		// Add additional menu items for active tab (if it's not current)...
		if (this.activeTabId !== tabId) {
			const activeCtrl = this.tabControllers[this.activeTabId];

			if (activeCtrl) {
				if (
					ctrl &&
					activeCtrl.getConnector().id === ctrl.getConnector().id
				) {
					return;
				}

				// ...but only if it has a different connector injected.
				this.addToggleConnectorMenu(tabId, activeCtrl);
			}
		}
	}

	/**
	 * Remove all items from the context menu.
	 */
	private resetContextMenu(): void {
		browser.contextMenus.removeAll();
	}

	/**
	 * Add a "Enable/Disable X" menu item for a given controller.
	 *
	 * @param tabId Tab ID
	 * @param ctrl Controller instance
	 */
	private addToggleConnectorMenu(tabId: number, ctrl: Controller): void {
		const { label } = ctrl.getConnector();
		const titleId = ctrl.isEnabled
			? 'menuDisableConnector'
			: 'menuEnableConnector';
		const itemTitle = L(titleId, label);
		const newState = !ctrl.isEnabled;

		this.addContextMenuItem(tabId, itemTitle, () => {
			this.setConnectorState(ctrl, newState);
		});
	}

	/**
	 * Add a "Disable X until tab is closed" menu item for a given controller.
	 *
	 * @param tabId Tab ID
	 * @param ctrl Controller instance
	 */
	private addDisableUntilTabClosedItem(
		tabId: number,
		ctrl: Controller
	): void {
		const { label } = ctrl.getConnector();
		const itemTitle2 = L('menuDisableUntilTabClosed', label);
		this.addContextMenuItem(tabId, itemTitle2, () => {
			ctrl.setEnabled(false);
		});
	}

	/**
	 * Helper function to add item to page action context menu.
	 *
	 * @param tabId Tab ID
	 * @param title Item title
	 * @param onClicked Function that will be called on item click
	 */
	private addContextMenuItem(
		tabId: number,
		title: string,
		onClicked: () => void
	): void {
		const onclick = () => {
			onClicked();

			this.updateContextMenu(tabId);
			if (this.shouldUpdateBrowserAction(tabId)) {
				this.updateBrowserAction(tabId);
			}
		};

		const type = 'normal';
		browser.contextMenus.create({
			title,
			type,
			onclick,
			contexts: ['browser_action'],
		});
	}

	/**
	 * Called when a controller changes its mode.
	 *
	 * @param ctrl  Controller instance
	 * @param tabId ID of a tab attached to the controller
	 */
	private processControlleModeChange(ctrl: Controller, tabId: number): void {
		const isCtrlModeInactive = isInactiveMode(ctrl.getMode());
		let isActiveCtrlChanged = false;

		if (this.activeTabId !== tabId) {
			if (isCtrlModeInactive) {
				return;
			}

			this.activeTabId = tabId;
			isActiveCtrlChanged = true;
		}

		if (isActiveCtrlChanged) {
			this.updateContextMenu(this.currentTabId);
		}

		if (isCtrlModeInactive) {
			// Use the current tab as a context
			this.updateBrowserAction(this.currentTabId);
		} else {
			// Use a tab to which the given controller attached as a context
			this.updateBrowserAction(tabId);
		}
	}

	/**
	 * Notify other modules if a controller updated the song.
	 *
	 * @param ctrl Controller instance
	 */
	private async notifySongIsUpdated(ctrl: Controller): Promise<void> {
		const track = ctrl.getCurrentSong().getCloneableData();

		try {
			await sendMessageToAll(Event.TrackUpdated, { track });
		} catch (e) {
			// Suppress errors
		}
	}

	/**
	 * Make an attempt to inject a connector into a page.
	 *
	 * @param tabId An ID of a tab where the connector will be injected
	 * @param connector Connector match object
	 */
	private async tryToInjectConnector(
		tabId: number,
		connector: ConnectorEntry
	): Promise<void> {
		const result = await injectConnector(tabId, connector);

		switch (result) {
			case InjectResult.Injected: {
				return;
			}

			case InjectResult.NoMatch: {
				if (this.tabControllers[tabId]) {
					this.unloadController(tabId);
					this.updateLastActiveTab();
				}
				break;
			}

			case InjectResult.Matched: {
				this.unloadController(tabId);
				this.createController(tabId, connector);

				if (this.shouldUpdateBrowserAction(tabId)) {
					this.updateBrowserAction(tabId);
				}
				this.updateContextMenu(tabId);

				sendMessageToContentScripts(tabId, Event.Ready);
				break;
			}
		}
	}

	/**
	 * Create a controller for a tab.
	 *
	 * @param tabId An ID of a tab bound to the controller
	 * @param connector A connector match object
	 */
	private createController(tabId: number, connector: ConnectorEntry): void {
		const isEnabled = isConnectorEnabled(connector);
		const ctrl = new Controller(tabId, connector, isEnabled);
		ctrl.onSongUpdated = () => {
			this.notifySongIsUpdated(ctrl);
		};
		ctrl.onModeChanged = () => {
			this.processControlleModeChange(ctrl, tabId);
		};
		ctrl.onControllerEvent = (event: ControllerEvent) => {
			this.onControllerEvent(ctrl, event);
		};

		this.tabControllers[tabId] = ctrl;
	}

	/**
	 * Stop and remove controller for a tab with a given tab ID.
	 *
	 * @param tabId Tab ID
	 */
	private unloadController(tabId: number): void {
		const controller = this.tabControllers[tabId];
		if (!controller) {
			return;
		}

		controller.finish();
		delete this.tabControllers[tabId];
	}

	/**
	 * Enable or disable a connector attached to a given controller.
	 *
	 * @param ctrl Controller instance
	 * @param isEnabled Flag value
	 */
	private setConnectorState(ctrl: Controller, isEnabled: boolean): void {
		const connector = ctrl.getConnector();

		ctrl.setEnabled(isEnabled);
		setConnectorEnabled(connector, isEnabled);
	}
}
