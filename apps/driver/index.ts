import { registerRootComponent } from "expo";
import "./src/location-task"; // must load at startup so the OS can wake the task in the background
import App from "./src/App";

registerRootComponent(App);
