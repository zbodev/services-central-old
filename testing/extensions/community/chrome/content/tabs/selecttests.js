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
 * The Original Code is the Mozilla Community QA Extension
 *
 * The Initial Developer of the Original Code is the Mozilla Corporation.
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Ben Hsieh <bhsieh@mozilla.com>
 *  Zach Lipton <zach@zachlipton.com>
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


var updateFunction;
var handleCancel;
var handleOK;
var sTestrunsWrapper; // an array of things that are kind of like testruns,
                      // but w/o important fields.
                      //returned by "test_runs_by_branch_product_name="

var sTestrun;   // actual testrun
var sTestgroup;
function handleLoad() {

  if (window.arguments.length > 0) {
    updateFunction = window.arguments[0];   // parent window passes in a function to update itself with data
    handleCancel = window.arguments[1];     // parent window passes in a function to restore state if dialog canceled
    handleOK = window.arguments[2];         // you get the idea
  }
  litmus.getTestruns(populateTestRuns);
}

function handleRunSelect() {
  var id = $("qa-st-testrun").selectedItem.getAttribute("value");
  if (id == "") return;
    // oddly, this check doesn't seem necessary in the other handlers...
  litmus.getTestrun(id, populateTestGroups);
}

function handleTestgroupSelect() {
  var id = document.getElementById("qa-st-testgroup").selectedItem.value;
  litmus.getTestgroup(id, populateSubgroups);
}

function handleSubgroupSelect() {
  var id = document.getElementById("qa-st-subgroup").selectedItem.value;
  updateCaller(sTestrun.name, sTestgroup.name, id, 0);
}

function populateTestRuns(testrunsWrapper) {
  var menu = document.getElementById("qa-st-testrun");
  testrunsWrapper = qaTools.arrayify(testrunsWrapper);
  sTestrunsWrapper = testrunsWrapper;

  while (menu.firstChild) {  // clear menu
    menu.removeChild(menu.firstChild);
  }

  for (var i = 0; i < testrunsWrapper.length; i++) {
    if (testrunsWrapper[i].enabled == 0) continue;
    var item = menu.appendItem(testrunsWrapper[i].name,
                              testrunsWrapper[i].test_run_id);
  }
  menu.selectedIndex = 0;
  handleRunSelect();
}

function populateTestGroups(testrun) {
  sTestrun = testrun;
  var menu = document.getElementById("qa-st-testgroup");
  while (menu.firstChild) {  // clear menu
    menu.removeChild(menu.firstChild);
  }

  var testgroups = qaTools.arrayify(testrun.testgroups);
  for (var i = 0; i < testgroups.length; i++) {
    if (testgroups[i].enabled == 0) continue;
    menu.appendItem(testgroups[i].name, testgroups[i].testgroup_id);
  }
  menu.selectedIndex = 0;
}

function populateSubgroups(testgroup) {
  sTestgroup = testgroup;
  var menu = document.getElementById("qa-st-subgroup");
  while (menu.firstChild) {  // clear menu
    menu.removeChild(menu.firstChild);
  }
  var subgroups = qaTools.arrayify(testgroup.subgroups);

  for (var i = 0; i < subgroups.length; i++) {
    if (subgroups[i].enabled == 0) continue;
    menu.appendItem(subgroups[i].name, subgroups[i].subgroup_id);
  }
  menu.selectedIndex = 0;
}

function OK() {
  handleOK();
  return true;
}

function updateCaller(testrunSummary, testgroupSummary, subgroupID, index) {
  litmus.writeStateToPref(testrunSummary, testgroupSummary, subgroupID, index);
  updateFunction();
}

function Cancel() {
  handleCancel();
  return true;
}
