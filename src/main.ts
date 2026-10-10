import { Plugin } from "obsidian";

export default class LetsHearItPlugin extends Plugin {
	async onload() {
		console.log("Loading let's hear it plugin...");
	}

	onunload() {
		console.log("Unloading let's hear it plugin...");
	}
}
