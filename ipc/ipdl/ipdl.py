# ***** BEGIN LICENSE BLOCK *****
# Version: MPL 1.1/GPL 2.0/LGPL 2.1
#
# The contents of this file are subject to the Mozilla Public License Version
# 1.1 (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.mozilla.org/MPL/
#
# Software distributed under the License is distributed on an "AS IS" basis,
# WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
# for the specific language governing rights and limitations under the
# License.
#
# The Original Code is mozilla.org code.
#
# Contributor(s):
#   Chris Jones <jones.chris.g@gmail.com>
#
# Alternatively, the contents of this file may be used under the terms of
# either of the GNU General Public License Version 2 or later (the "GPL"),
# or the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
# in which case the provisions of the GPL or the LGPL are applicable instead
# of those above. If you wish to allow use of your version of this file only
# under the terms of either the GPL or the LGPL, and not to allow others to
# use your version of this file under the terms of the MPL, indicate your
# decision by deleting the provisions above and replace them with the notice
# and other provisions required by the GPL or the LGPL. If you do not delete
# the provisions above, a recipient may use your version of this file under
# the terms of any one of the MPL, the GPL or the LGPL.
#
# ***** END LICENSE BLOCK *****

import optparse, os, re, sys
from cStringIO import StringIO

import ipdl

def log(minv, fmt, *args):
    if _verbosity >= minv:
        print >>sys.stderr, fmt % args

# process command line

op = optparse.OptionParser(usage='ipdl.py [options] IPDLfiles...')
op.add_option('-d', '--output-dir', dest='outputdir', default='.',
              help='Directory in which to put generated headers')
op.add_option('-I', '--include', dest='includedirs', default=[ ],
              action='append',
              help='Additional directory to search for included protocol specifications')
op.add_option('-v', '--verbose', dest='verbosity', default=1, action='count',
              help='Verbose logging (specify -vv or -vvv for very verbose logging)')
op.add_option('-q', '--quiet', dest='verbosity', action='store_const', const=0,
              help="Suppress logging output")

options, files = op.parse_args()
_verbosity = options.verbosity
codedir = options.outputdir
includedirs = [ os.path.abspath(incdir) for incdir in options.includedirs ]

if not len(files):
    op.error("No IPDL files specified")

log(1, 'Generated headers will be placed in "%s"', codedir)

allprotocols = []

for f in files:
    log(1, 'Parsing specification %s', f)
    if f == '-':
        fd = sys.stdin
        filename = '<stdin>'
    else:
        fd = open(f)
        filename = f

    specstring = fd.read()
    fd.close()

    ast = ipdl.parse(specstring, filename, includedirs=includedirs)

    allprotocols.append,('%sProtocolMsgStart' % ast.protocol.name)

    log(2, 'checking types')
    if not ipdl.typecheck(ast):
        print >>sys.stderr, 'Specification is not well typed.'
        sys.exit(1)

    if _verbosity > 2:
        log(3, '  pretty printed code:')
        ipdl.genipdl(ast, codedir)

    ipdl.gencxx(ast, codedir)

allprotocols.sort()

ipcmsgstart = StringIO()

print >>ipcmsgstart, """
// CODE GENERATED by ipdl.py. Do not edit.

enum IPCMessageStart {
"""

for name in allprotocols:
    print >>ipcmsgstart, "  %s," % name

print >>ipcmsgstart, """
  LastMsgIndex
};
"""

ipdl.writeifmodified(ipcmsgstart.getvalue(),
                     os.path.join(codedir, 'IPCMessageStart.h'))
