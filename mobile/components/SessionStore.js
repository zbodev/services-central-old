/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Session Store.
 *
 * The Initial Developer of the Original Code is Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Mark 'evil' Finkle <mfinkle@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

#ifdef MOZ_CRASH_REPORTER
XPCOMUtils.defineLazyServiceGetter(this, "CrashReporter",
  "@mozilla.org/xre/app-info;1", "nsICrashReporter");
#endif

XPCOMUtils.defineLazyGetter(this, "NetUtil", function() {
  Cu.import("resource://gre/modules/NetUtil.jsm");
  return NetUtil;
});

// -----------------------------------------------------------------------
// Session Store
// -----------------------------------------------------------------------

const STATE_STOPPED = 0;
const STATE_RUNNING = 1;
const STATE_QUITTING = -1;

function SessionStore() { }

SessionStore.prototype = {
  classID: Components.ID("{8c1f07d6-cba3-4226-a315-8bd43d67d032}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsISessionStore,
                                         Ci.nsIDOMEventListener,
                                         Ci.nsIObserver,
                                         Ci.nsISupportsWeakReference]),

  _windows: {},
  _lastSaveTime: 0,
  _lastSessionTime: 0,
  _interval: 10000,
  _maxTabsUndo: 1,
  _shouldRestore: false,

  init: function ss_init() {
    // Get file references
    this._sessionFile = Services.dirsvc.get("ProfD", Ci.nsILocalFile);
    this._sessionFileBackup = this._sessionFile.clone();
    this._sessionCache = this._sessionFile.clone();
    this._sessionFile.append("sessionstore.js");
    this._sessionFileBackup.append("sessionstore.bak");
    this._sessionCache.append("sessionstoreCache");

    this._loadState = STATE_STOPPED;

    try {
      if (this._sessionFileBackup.exists()) {
        this._shouldRestore = true;
        this._sessionFileBackup.remove(false);
      }

      if (this._sessionFile.exists()) {
        // Disable crash recovery if we have exceeded the timeout
        this._lastSessionTime = this._sessionFile.lastModifiedTime;
        let delta = Date.now() - this._lastSessionTime;
        let timeout = Services.prefs.getIntPref("browser.sessionstore.resume_from_crash_timeout");
        if (delta > (timeout * 60000))
          this._shouldRestore = false;

        this._sessionFile.copyTo(null, this._sessionFileBackup.leafName);
      }

      if (!this._sessionCache.exists() || !this._sessionCache.isDirectory())
        this._sessionCache.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);
    } catch (ex) {
      Cu.reportError(ex); // file was write-locked?
    }

    this._interval = Services.prefs.getIntPref("browser.sessionstore.interval");
    this._maxTabsUndo = Services.prefs.getIntPref("browser.sessionstore.max_tabs_undo");

    // Disable crash recovery if it has been turned off
    if (!Services.prefs.getBoolPref("browser.sessionstore.resume_from_crash"))
      this._shouldRestore = false;

    // Do we need to restore session just this once, in case of a restart?
    if (Services.prefs.getBoolPref("browser.sessionstore.resume_session_once")) {
      Services.prefs.setBoolPref("browser.sessionstore.resume_session_once", false);
      this._shouldRestore = true;
    }
  },

  _clearDisk: function ss_clearDisk() {
    if (this._sessionFile.exists()) {
      try {
        this._sessionFile.remove(false);
      } catch (ex) { dump(ex + '\n'); } // couldn't remove the file - what now?
    }
    if (this._sessionFileBackup.exists()) {
      try {
        this._sessionFileBackup.remove(false);
      } catch (ex) { dump(ex + '\n'); } // couldn't remove the file - what now?
    }

    this._clearCache();
  },

  _clearCache: function ss_clearCache() {
    // First, let's get a list of files we think should be active
    let activeFiles = [];
    this._forEachBrowserWindow(function(aWindow) {
      let tabs = aWindow.Browser.tabs;
      for (let i = 0; i < tabs.length; i++) {
        let browser = tabs[i].browser;
        if (browser.__SS_extdata && "thumbnail" in browser.__SS_extdata)
          activeFiles.push(browser.__SS_extdata.thumbnail);
      }
    });

    // Now, let's find the stale files in the cache folder
    let staleFiles = [];
    let cacheFiles = this._sessionCache.directoryEntries;
    while (cacheFiles.hasMoreElements()) {
      let file = cacheFiles.getNext().QueryInterface(Ci.nsILocalFile);
      let fileURI = Services.io.newFileURI(file);
      if (activeFiles.indexOf(fileURI) == -1)
        staleFiles.push(file);
    }

    // Remove the stale files in a separate step to keep the enumerator from
    // messing up if we remove the files as we collect them.
    staleFiles.forEach(function(aFile) {
      aFile.remove(false);
    })
  },

  observe: function ss_observe(aSubject, aTopic, aData) {
    let self = this;
    let observerService = Services.obs;
    switch (aTopic) {
      case "app-startup":
        observerService.addObserver(this, "final-ui-startup", true);
        observerService.addObserver(this, "domwindowopened", true);
        observerService.addObserver(this, "domwindowclosed", true);
        observerService.addObserver(this, "browser-lastwindow-close-granted", true);
        observerService.addObserver(this, "browser:purge-session-history", true);
        observerService.addObserver(this, "quit-application-requested", true);
        observerService.addObserver(this, "quit-application-granted", true);
        observerService.addObserver(this, "quit-application", true);
        break;
      case "final-ui-startup":
        observerService.removeObserver(this, "final-ui-startup");
        this.init();
        break;
      case "domwindowopened":
        let window = aSubject;
        window.addEventListener("load", function() {
          self.onWindowOpen(window);
          window.removeEventListener("load", arguments.callee, false);
        }, false);
        break;
      case "domwindowclosed": // catch closed windows
        this.onWindowClose(aSubject);
        break;
      case "browser-lastwindow-close-granted":
        // If a save has been queued, kill the timer and save state now
        if (this._saveTimer) {
          this._saveTimer.cancel();
          this._saveTimer = null;
          this.saveState();
        }

        // Freeze the data at what we've got (ignoring closing windows)
        this._loadState = STATE_QUITTING;
        break;
      case "quit-application-requested":
        // Get a current snapshot of all windows
        this._forEachBrowserWindow(function(aWindow) {
          self._collectWindowData(aWindow);
        });
        break;
      case "quit-application-granted":
        // Get a current snapshot of all windows
        this._forEachBrowserWindow(function(aWindow) {
          self._collectWindowData(aWindow);
        });

        // Freeze the data at what we've got (ignoring closing windows)
        this._loadState = STATE_QUITTING;
        break;
      case "quit-application":
        // If we are restarting, lets restore the tabs
        if (aData == "restart") {
          Services.prefs.setBoolPref("browser.sessionstore.resume_session_once", true);

          // Ignore purges when restarting. The notification is fired after "quit-application".
          Services.obs.removeObserver(this, "browser:purge-session-history");
        }

        // Freeze the data at what we've got (ignoring closing windows)
        this._loadState = STATE_QUITTING;

        // No need for this back up, we are shutting down just fine
        if (this._sessionFileBackup.exists())
          this._sessionFileBackup.remove(false);

        observerService.removeObserver(this, "domwindowopened");
        observerService.removeObserver(this, "domwindowclosed");
        observerService.removeObserver(this, "browser-lastwindow-close-granted");
        observerService.removeObserver(this, "quit-application-requested");
        observerService.removeObserver(this, "quit-application-granted");
        observerService.removeObserver(this, "quit-application");

        // If a save has been queued, kill the timer and save state now
        if (this._saveTimer) {
          this._saveTimer.cancel();
          this._saveTimer = null;
          this.saveState();
        }
        break;
      case "browser:purge-session-history": // catch sanitization 
        this._clearDisk();

        // If the browser is shutting down, simply return after clearing the
        // session data on disk as this notification fires after the
        // quit-application notification so the browser is about to exit.
        if (this._loadState == STATE_QUITTING)
          return;

        // Clear all data about closed tabs
        for (let [ssid, win] in Iterator(this._windows))
          win.closedTabs = [];

        if (this._loadState == STATE_RUNNING) {
          // Save the purged state immediately
          this.saveStateNow();
        }
        break;
      case "timer-callback":
        // Timer call back for delayed saving
        this._saveTimer = null;
        this.saveState();
        break;
    }
  },

  handleEvent: function ss_handleEvent(aEvent) {
    let window = aEvent.currentTarget.ownerDocument.defaultView;
    switch (aEvent.type) {
      case "TabOpen":
      case "TabClose": {
        let browser = aEvent.originalTarget.linkedBrowser;
        if (aEvent.type == "TabOpen") {
          this.onTabAdd(window, browser);
        }
        else {
          this.onTabClose(window, browser);
          this.onTabRemove(window, browser);
        }
        break;
    }
      case "TabSelect": {
        let browser = aEvent.originalTarget.linkedBrowser;
        this.onTabSelect(window, browser);
        break;
      }
    }
  },

  receiveMessage: function ss_receiveMessage(aMessage) {
    let window = aMessage.target.ownerDocument.defaultView;
    this.onTabLoad(window, aMessage.target, aMessage);
  },

  onWindowOpen: function ss_onWindowOpen(aWindow) {
    // Return if window has already been initialized
    if (aWindow && aWindow.__SSID && this._windows[aWindow.__SSID])
      return;

    // Ignore non-browser windows and windows opened while shutting down
    if (aWindow.document.documentElement.getAttribute("windowtype") != "navigator:browser" || this._loadState == STATE_QUITTING)
      return;

    // Assign it a unique identifier (timestamp) and create its data object
    aWindow.__SSID = "window" + Date.now();
    this._windows[aWindow.__SSID] = { tabs: [], selected: 0, closedTabs: [] };

    // Perform additional initialization when the first window is loading
    if (this._loadState == STATE_STOPPED) {
      this._loadState = STATE_RUNNING;
      this._lastSaveTime = Date.now();

      // Nothing to restore, notify observers things are complete
      if (!this._shouldRestore) {
        this._clearCache();
        Services.obs.notifyObservers(null, "sessionstore-windows-restored", "");
      }
    }

    // Add tab change listeners to all already existing tabs
    let tabs = aWindow.Browser.tabs;
    for (let i = 0; i < tabs.length; i++)
      this.onTabAdd(aWindow, tabs[i].browser, true);

    // Notification of tab add/remove/selection
    let tabContainer = aWindow.document.getElementById("tabs");
    tabContainer.addEventListener("TabOpen", this, true);
    tabContainer.addEventListener("TabClose", this, true);
    tabContainer.addEventListener("TabSelect", this, true);
  },

  onWindowClose: function ss_onWindowClose(aWindow) {
    // Ignore windows not tracked by SessionStore
    if (!aWindow.__SSID || !this._windows[aWindow.__SSID])
      return;

    let tabContainer = aWindow.document.getElementById("tabs");
    tabContainer.removeEventListener("TabOpen", this, true);
    tabContainer.removeEventListener("TabClose", this, true);
    tabContainer.removeEventListener("TabSelect", this, true);

    if (this._loadState == STATE_RUNNING) {
      // Update all window data for a last time
      this._collectWindowData(aWindow);

      // Clear this window from the list
      delete this._windows[aWindow.__SSID];

      // Save the state without this window to disk
      this.saveStateDelayed();
    }

    let tabs = aWindow.Browser.tabs;
    for (let i = 0; i < tabs.length; i++)
      this.onTabRemove(aWindow, tabs[i].browser, true);

    delete aWindow.__SSID;
  },

  onTabAdd: function ss_onTabAdd(aWindow, aBrowser, aNoNotification) {
    aBrowser.messageManager.addMessageListener("pageshow", this);
    aBrowser.messageManager.addMessageListener("Content:SessionHistory", this);

    if (!aNoNotification)
      this.saveStateDelayed();
    this._updateCrashReportURL(aWindow);
  },

  onTabRemove: function ss_onTabRemove(aWindow, aBrowser, aNoNotification) {
    aBrowser.messageManager.removeMessageListener("pageshow", this);
    aBrowser.messageManager.removeMessageListener("Content:SessionHistory", this);

    // If this browser is being restored, skip any session save activity
    if (aBrowser.__SS_restore)
      return;

    delete aBrowser.__SS_data;

    if (!aNoNotification)
      this.saveStateDelayed();
  },

  onTabClose: function ss_onTabClose(aWindow, aBrowser) {
    if (this._maxTabsUndo == 0)
      return;

    if (aWindow.Browser.tabs.length > 0) {
      // Bundle this browser's data and extra data and save in the closedTabs
      // window property
      let data = aBrowser.__SS_data;
      data.extData = aBrowser.__SS_extdata;

      this._windows[aWindow.__SSID].closedTabs.unshift(data);
      let length = this._windows[aWindow.__SSID].closedTabs.length;
      if (length > this._maxTabsUndo)
        this._windows[aWindow.__SSID].closedTabs.splice(this._maxTabsUndo, length - this._maxTabsUndo);
    }
  },

  onTabLoad: function ss_onTabLoad(aWindow, aBrowser, aMessage) {
    // If this browser is being restored, skip any session save activity
    if (aBrowser.__SS_restore)
      return;

    // Ignore a transient "about:blank"
    if (!aBrowser.canGoBack && aBrowser.currentURI.spec == "about:blank")
      return;

    if (aMessage.name == "Content:SessionHistory") {
      delete aBrowser.__SS_data;
      this._collectTabData(aBrowser, aMessage.json);
    }

    // Save out the state as quickly as possible
    if (aMessage.name == "pageshow")
      this.saveStateNow();

    this._updateCrashReportURL(aWindow);
  },

  onTabSelect: function ss_onTabSelect(aWindow, aBrowser) {
    if (this._loadState != STATE_RUNNING)
      return;

    let index = aWindow.Elements.browsers.selectedIndex;
    this._windows[aWindow.__SSID].selected = parseInt(index) + 1; // 1-based

    // Restore the resurrected browser
    if (aBrowser.__SS_restore) {
      let data = aBrowser.__SS_data;
      if (data.entries.length > 0) {
        let json = {
          uri: data.entries[data.index - 1].url,
          flags: null,
          entries: data.entries,
          index: data.index
        };
        aBrowser.messageManager.sendAsyncMessage("WebNavigation:LoadURI", json);
      }

      delete aBrowser.__SS_restore;
    }

    this._updateCrashReportURL(aWindow);
  },

  saveStateDelayed: function ss_saveStateDelayed() {
    if (!this._saveTimer) {
      // Interval until the next disk operation is allowed
      let minimalDelay = this._lastSaveTime + this._interval - Date.now();

      // If we have to wait, set a timer, otherwise saveState directly
      let delay = Math.max(minimalDelay, 2000);
      if (delay > 0) {
        this._saveTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        this._saveTimer.init(this, delay, Ci.nsITimer.TYPE_ONE_SHOT);
      } else {
        this.saveState();
      }
    }
  },

  saveStateNow: function ss_saveStateNow() {
    // Kill any queued timer and save immediately
    if (this._saveTimer) {
      this._saveTimer.cancel();
      this._saveTimer = null;
    }
    this.saveState();
  },

  saveState: function ss_saveState() {
    let data = this._getCurrentState();
    this._writeFile(this._sessionFile, JSON.stringify(data));

    this._lastSaveTime = Date.now();
  },

  _getCurrentState: function ss_getCurrentState() {
    let self = this;
    this._forEachBrowserWindow(function(aWindow) {
      self._collectWindowData(aWindow);
    });

    let data = { windows: [] };
    let index;
    for (index in this._windows)
      data.windows.push(this._windows[index]);
    return data;
  },

  _collectTabData: function ss__collectTabData(aBrowser, aHistory) {
    // If this browser is being restored, skip any session save activity
    if (aBrowser.__SS_restore)
      return;

    let aHistory = aHistory || { entries: [{ url: aBrowser.currentURI.spec, title: aBrowser.contentTitle }], index: 1 };

    let tabData = {};
    tabData.entries = aHistory.entries;
    tabData.index = aHistory.index;
    tabData.attributes = { image: aBrowser.mIconURL };

    aBrowser.__SS_data = tabData;
  },

  _collectWindowData: function ss__collectWindowData(aWindow) {
    // Ignore windows not tracked by SessionStore
    if (!aWindow.__SSID || !this._windows[aWindow.__SSID])
      return;

    let winData = this._windows[aWindow.__SSID];
    winData.tabs = [];

    let index = aWindow.Elements.browsers.selectedIndex;
    winData.selected = parseInt(index) + 1; // 1-based

    let tabs = aWindow.Browser.tabs;
    for (let i = 0; i < tabs.length; i++) {
      let browser = tabs[i].browser;
      if (browser.__SS_data) {
        let tabData = browser.__SS_data;
        if (browser.__SS_extdata)
          tabData.extData = browser.__SS_extdata;
        winData.tabs.push(tabData);
      }
    }
  },

  _forEachBrowserWindow: function ss_forEachBrowserWindow(aFunc) {
    let windowsEnum = Services.wm.getEnumerator("navigator:browser");
    while (windowsEnum.hasMoreElements()) {
      let window = windowsEnum.getNext();
      if (window.__SSID && !window.closed)
        aFunc.call(this, window);
    }
  },

  _writeFile: function ss_writeFile(aFile, aData) {
    let stateString = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    stateString.data = aData;
    Services.obs.notifyObservers(stateString, "sessionstore-state-write", "");

    // Don't touch the file if an observer has deleted all state data
    if (!stateString.data)
      return;

    // Initialize the file output stream.
    let ostream = Cc["@mozilla.org/network/safe-file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
    ostream.init(aFile, 0x02 | 0x08 | 0x20, 0600, ostream.DEFER_OPEN);

    // Obtain a converter to convert our data to a UTF-8 encoded input stream.
    let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";

    // Asynchronously copy the data to the file.
    let istream = converter.convertToInputStream(aData);
    NetUtil.asyncCopy(istream, ostream, function(rc) {
      if (Components.isSuccessCode(rc)) {
        Services.obs.notifyObservers(null, "sessionstore-state-write-complete", "");
      }
    });
  },

  _updateCrashReportURL: function ss_updateCrashReportURL(aWindow) {
#ifdef MOZ_CRASH_REPORTER
    try {
      let currentURI = aWindow.Browser.selectedBrowser.currentURI.clone();
      // if the current URI contains a username/password, remove it
      try {
        currentURI.userPass = "";
      }
      catch (ex) { } // ignore failures on about: URIs

      CrashReporter.annotateCrashReport("URL", currentURI.spec);
    }
    catch (ex) {
      // don't make noise when crashreporter is built but not enabled
      if (ex.result != Components.results.NS_ERROR_NOT_INITIALIZED)
        Components.utils.reportError("SessionStore:" + ex);
    }
#endif
  },

  getBrowserState: function ss_getBrowserState() {
    let data = this._getCurrentState();
    return JSON.stringify(data);
  },

  getClosedTabCount: function ss_getClosedTabCount(aWindow) {
    if (!aWindow || !aWindow.__SSID)
      return 0; // not a browser window, or not otherwise tracked by SS.

    return this._windows[aWindow.__SSID].closedTabs.length;
  },

  getClosedTabData: function ss_getClosedTabData(aWindow) {
    if (!aWindow.__SSID)
      throw (Components.returnCode = Cr.NS_ERROR_INVALID_ARG);

    return JSON.stringify(this._windows[aWindow.__SSID].closedTabs);
  },

  undoCloseTab: function ss_undoCloseTab(aWindow, aIndex) {
    if (!aWindow.__SSID)
      throw (Components.returnCode = Cr.NS_ERROR_INVALID_ARG);

    let closedTabs = this._windows[aWindow.__SSID].closedTabs;
    if (!closedTabs)
      return null;

    // default to the most-recently closed tab
    aIndex = aIndex || 0;
    if (!(aIndex in closedTabs))
      throw (Components.returnCode = Cr.NS_ERROR_INVALID_ARG);

    // fetch the data of closed tab, while removing it from the array
    let closedTab = closedTabs.splice(aIndex, 1).shift();

    // create a new tab and bring to front
    let tab = aWindow.Browser.addTab(closedTab.entries[closedTab.index - 1].url, true);

    tab.browser.messageManager.sendAsyncMessage("WebNavigation:LoadURI", {
      uri: closedTab.entries[closedTab.index - 1].url,
      flags: null,
      entries: closedTab.entries,
      index: closedTab.index
    });

    // Put back the extra data
    tab.browser.__SS_extdata = closedTab.extData;

    return tab.chromeTab;
  },

  forgetClosedTab: function ss_forgetClosedTab(aWindow, aIndex) {
    if (!aWindow.__SSID)
      throw (Components.returnCode = Cr.NS_ERROR_INVALID_ARG);

    let closedTabs = this._windows[aWindow.__SSID].closedTabs;

    // default to the most-recently closed tab
    aIndex = aIndex || 0;
    if (!(aIndex in closedTabs))
      throw (Components.returnCode = Cr.NS_ERROR_INVALID_ARG);

    // remove closed tab from the array
    closedTabs.splice(aIndex, 1);
  },

  getTabValue: function ss_getTabValue(aTab, aKey) {
    let browser = aTab.linkedBrowser;
    let data = browser.__SS_extdata || {};
    return data[aKey] || "";
  },

  setTabValue: function ss_setTabValue(aTab, aKey, aStringValue) {
    let browser = aTab.linkedBrowser;

    // Thumbnails are actually stored in the cache, so do the save and update the URI
    if (aKey == "thumbnail") {
      let file = this._sessionCache.clone();
      file.append("thumbnail-" + browser.contentWindowId);
      file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0600);

      let source = Services.io.newURI(aStringValue, "UTF8", null);
      let target = Services.io.newFileURI(file)

      let persist = Cc["@mozilla.org/embedding/browser/nsWebBrowserPersist;1"].createInstance(Ci.nsIWebBrowserPersist);
      persist.persistFlags = Ci.nsIWebBrowserPersist.PERSIST_FLAGS_REPLACE_EXISTING_FILES | Ci.nsIWebBrowserPersist.PERSIST_FLAGS_AUTODETECT_APPLY_CONVERSION;
      persist.saveURI(source, null, null, null, null, file);

      aStringValue = target.spec;
    }

    if (!browser.__SS_extdata)
      browser.__SS_extdata = {};
    browser.__SS_extdata[aKey] = aStringValue;
    this.saveStateDelayed();
  },

  deleteTabValue: function ss_deleteTabValue(aTab, aKey) {
    let browser = aTab.linkedBrowser;
    if (browser.__SS_extdata && browser.__SS_extdata[aKey])
      delete browser.__SS_extdata[aKey];
    else
      throw (Components.returnCode = Cr.NS_ERROR_INVALID_ARG);
  },

  shouldRestore: function ss_shouldRestore() {
    return this._shouldRestore;
  },

  restoreLastSession: function ss_restoreLastSession(aBringToFront) {
    // The previous session data has already been renamed to the backup file
    if (!this._sessionFileBackup.exists())
      return;

    let self = this;
    function notifyObservers() {
      self._clearCache();
      Services.obs.notifyObservers(null, "sessionstore-windows-restored", "");
    }

    try {
      let channel = NetUtil.newChannel(this._sessionFileBackup);
      channel.contentType = "application/json";
      NetUtil.asyncFetch(channel, function(aStream, aResult) {
        if (!Components.isSuccessCode(aResult)) {
          Cu.reportError("SessionStore: Could not read from sessionstore.bak file");
          notifyObservers();
          return;
        }

        // Read session state file into a string and let observers modify the state before it's being used
        let state = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
        state.data = NetUtil.readInputStreamToString(aStream, aStream.available()) || "";
        aStream.close();

        Services.obs.notifyObservers(state, "sessionstore-state-read", "");

        let data = null;
        try {
          data = JSON.parse(state.data);
        } catch (ex) {
          Cu.reportError("SessionStore: Could not parse JSON: " + ex);
        }

        if (!data || data.windows.length == 0) {
          notifyObservers();
          return;
        }

        let window = Services.wm.getMostRecentWindow("navigator:browser");

        let selected = data.windows[0].selected;
        let tabs = data.windows[0].tabs;
        for (let i=0; i<tabs.length; i++) {
          let tabData = tabs[i];

          // Add a tab, but don't load the URL until we need to
          let params = { getAttention: false, delayLoad: true };

          // We must have selected tabs as soon as possible, so we let all tabs be selected
          // until we get the real selected tab. Then we stop selecting tabs. The end result
          // is that the right tab is selected, but we also don't get a bunch of errors
          let bringToFront = (i + 1 <= selected) && aBringToFront;
          let tab = window.Browser.addTab(tabData.entries[tabData.index - 1].url, bringToFront, null, params);

          // Start a real load for the selected tab
          if (i + 1 == selected) {
            let json = {
              uri: tabData.entries[tabData.index - 1].url,
              flags: null,
              entries: tabData.entries,
              index: tabData.index
            };
            tab.browser.messageManager.sendAsyncMessage("WebNavigation:LoadURI", json);
          } else {
            // Make sure the browser has its session data for the delay reload
            tab.browser.__SS_data = tabData;
            tab.browser.__SS_restore = true;

            // Recreate the thumbnail if we are delay loading the tab
            let canvas = tab.chromeTab.thumbnail;
            canvas.setAttribute("restored", "true");
  
            let image = new window.Image();
            image.onload = function() {
              if (canvas)
                canvas.getContext("2d").drawImage(image, 0, 0);
            };
            image.src = tabData.extData.thumbnail;
          }

          tab.browser.__SS_extdata = tabData.extData;
        }
    
        notifyObservers();
      });
    } catch (ex) {
      Cu.reportError("SessionStore: Could not read from sessionstore.bak file: " + ex);
      notifyObservers();
    }
  }
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([SessionStore]);
