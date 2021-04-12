# -*- coding: utf-8 -*-
import sys
import base64


is_python2 = sys.version_info[0] == 2


locations = {}


class ResolveLocations(gdb.Function):
    """"""

    def __init__(self):
        super(ResolveLocations, self).__init__('resolve_locations')

    def invoke(self, *args):
        locations.clear()
        for addr in args:
            pc_line = gdb.find_pc_line(int(addr))
            if (pc_line.pc != int(addr)):
                continue
            if pc_line.symtab is not None:
                location = {}
                location['pc'] = str(pc_line.pc)
                location['line'] = str(pc_line.line)
                location['filename'] = pc_line.symtab.filename
                location['fullname'] = pc_line.symtab.fullname()
                locations[int(addr)] = location
        if is_python2:
            return base64.b64encode(str(locations.keys()))
        else:
            return base64.b64encode(str(list(locations.keys())).encode()).decode()


class GetLocation(gdb.Function):
    """"""

    def __init__(self):
        super(GetLocation, self).__init__('get_location')

    def invoke(self, addr):
        if int(addr) not in locations:
            return
        obj = locations[int(addr)]
        if is_python2:
            return base64.b64encode(str(obj).replace("'", '"'))
        else:
            return base64.b64encode(str(obj).replace("'", '"').encode()).decode()


ResolveLocations()
GetLocation()
