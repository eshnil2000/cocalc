import logging, os, socket, ssl, struct, sys


#####################################################################
# The SQLalchemy database
#####################################################################



#####################################################################
# A simple test client
#####################################################################

class TestLogHandler(logging.Handler):
    def __init__(self, port, hostname):
        logging.Handler.__init__(self)
        self._hostname = str(hostname)
        self._port = int(port)
        self._socket = None

    def connect(self):
        self._socket = ssl.wrap_socket(socket.socket(socket.AF_INET, socket.SOCK_STREAM))
        try:
            self._socket.connect((self._hostname, self._port))
        except socket.error, err:
            print err
            self._socket = None
        
    def emit(self, record):
        if self._socket is None:
            self.connect()
        if self._socket is None: return
        mesg = str(record)
        length_header = struct.pack(">L", len(mesg))
        try:
            self._socket.sendall(length_header + mesg)
        except socket.error, err:
            print err
            self._socket.close()
            self._socket = None

    def __del__(self):
        if self._socket is not None:
            self._socket.shutdown(0)
            self._socket.close()

class TestLog(object):
    def __init__(self, port, hostname):
        self._hostname = hostname
        self._port = port
        self._rootLogger = logging.getLogger('')
        self._rootLogger.setLevel(logging.DEBUG)
        self._rootLogger.addHandler(TestLogHandler(port=port, hostname=hostname))

    def run(self):
        while True:
            logging.info(raw_input('mesg: '))
    

#####################################################################
# The non-blocking SSL-enabled Tornado-based handler 
#####################################################################

class TornadoLogHandler(logging.Handler):
    def __init__(self, port, hostname):
        logging.Handler.__init__(self)
        self._hostname = str(hostname)
        self._port = int(port)
        self._socket = None

    def connect(self):
        from tornado import iostream
        try:
            s = ssl.wrap_socket(socket.socket(socket.AF_INET, socket.SOCK_STREAM), do_handshake_on_connect=False)
            s.connect((self._hostname, self._port))
            self._socket = iostream.SSLIOStream(s)
        except socket.error, err:
            sys.stderr.write("TornadoLogHandler: connection to logger failed -- '%s'"%err)            
            self._socket = None
        
    def emit(self, record):
        if self._socket is None:
            self.connect()
        if self._socket is None: return
        mesg = str(record)
        length_header = struct.pack(">L", len(mesg))
        try:
            self._socket.write(length_header + mesg)
        except IOError, err:
            sys.stderr.write("TornadoLogHandler: logger down -- '%s'"%err)
            self._socket.close()
            self._socket = None

    def __del__(self):
        if self._socket is not None:
            self._socket.close()
        
        
class WebTestLog(object):
    def __init__(self, port, hostname):
        self._hostname = hostname
        self._port = port
        self._rootLogger = logging.getLogger('')
        self._rootLogger.setLevel(logging.DEBUG)
        self._rootLogger.addHandler(TornadoLogHandler(port=port, hostname=hostname))

    def run(self):
        logging.info('hello')
        return
        import tornado.ioloop
        import tornado.web
        class MainHandler(tornado.web.RequestHandler):
            def get(self):
                logging.info('hello')                
                self.write("Logger")

        application = tornado.web.Application([
            (r"/", MainHandler),
        ])
        application.listen(8888)
        tornado.ioloop.IOLoop.instance().start()
        



#####################################################################
# Python library (=command line) interface to the logging database
#####################################################################





#####################################################################
# The logging SSL-enabled database socket server 
#####################################################################
class LogServer(object):
    def __init__(self, port, certfile, dbfile, hostname, whitelist):
        self._port = port
        self._certfile = certfile
        self._dbfile = dbfile
        self._hostname = hostname
        self._whitelist = open(whitelist).read().split() if os.path.exists(whitelist) else None
        self._children = [] # todo: kill em all on exit and wait

    def __del__(self):
        for pid in self._children:
            try:
                print "Killing %s..."%pid
                os.kill(pid)
                os.wait(pid)
            except:
                pass

    def run(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        print "Bind to %s:%s"%(self._hostname, self._port)
        s.bind((self._hostname, self._port))
        s.listen(5)
        while True:
            print "Waiting for secure connection..."
            try:
                conn, addr = s.accept()
                if self._whitelist is not None and   addr not in self._whitelist:
                    print "Rejecting connection from %s since it is not in the whitelist"%addr
                    continue
                import ssl
                conn = ssl.wrap_socket(conn, server_side=True, certfile=self._certfile, keyfile=self._certfile)
            except Exception, err:
                sys.stderr.write("Error making connection: %s"%err)
                continue
            pid = os.fork()
            if pid == 0:
                # child
                self._recv_and_log_loop(conn)
            else:
                # parent
                print "Accepted a new connection, and created process %s to handle it"%pid
                self._children.append(pid)

    def _recv_and_log_loop(self, conn):
        while True:
            mesg = conn.recv(4)
            if len(mesg) < 4:
                break
            slen = struct.unpack('>L', mesg)[0]
            mesg = conn.recv(slen)
            while len(mesg) < slen:
                mesg += conn.recv(slen - len(mesg))
            self.handle(mesg)

    def handle(self, mesg):
        print mesg
                    

#####################################################################
# Web interface to the logging database
#####################################################################
class WebServer(object):
    def __init__(self, port, certfile, dbfile, hostname):
        self._port = port
        self._certfile = certfile
        self._dbfile = dbfile
        self._hostname = hostname

    def run(self):
        raise NotImplementedError




#####################################################################
# Handle command line options
#####################################################################

if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description="The Sagews Logging Module")

    parser.add_argument('--log_server', dest='log_server', action='store_const', const=True, default=False,
                        help="run as a log server that accepts ssl connections and writes to the database")
    parser.add_argument('--web_server', dest='web_server', action='store_const', const=True, default=False,
                        help="run a web server that allows one to browse the log database")
    
    parser.add_argument('--test_client', dest='test_client', action='store_const', const=True, default=False,
                        help="run a simple command line test client for the log server")
    parser.add_argument('--test_webclient', dest='test_webclient', action='store_const', const=True, default=False,
                        help="run a simple testing web client serving on a random port for the Torando-based log server")
    
    parser.add_argument("--hostname", dest="hostname", type=str, default=socket.gethostname(),
                        help="hostname/ip address for server to listen on")
    parser.add_argument("--port", dest="port", type=int, default=8514,
                        help="port to use for log server or web server (default: 8514)")

    parser.add_argument("--certfile", dest="certfile", type=str, default="cert.pem",
                        help="use or autogenerate the given certfile")
    parser.add_argument("--dbfile", dest="dbfile", type=str, default="log.sqlite3",
                        help="file in which to store the log database")
    parser.add_argument('--daemon', dest='daemon', action='store_const', const=True,
                        default=False, help="run as a daemon")
    parser.add_argument('--whitelist', dest='whitelist', type=str, default='',
                        help="file with rows ip addresses of computers that are allowed to connect")

    args = parser.parse_args()

    def main():
        if not os.path.exists(args.certfile):
            import subprocess
            subprocess.Popen(['openssl', 'req', '-batch', '-new', '-x509', '-newkey', 'rsa:1024', '-days', '9999', '-nodes', '-out', args.certfile, '-keyout', args.certfile]).wait()
            os.chmod(args.certfile, 0600)
        if args.log_server:
            LogServer(port=args.port, certfile=args.certfile, dbfile=args.dbfile,
                      hostname=args.hostname, whitelist=args.whitelist).run()
        elif args.web_server:
            WebServer(port=args.port, certfile=args.certfile, dbfile=args.dbfile, hostname=args.hostname).run()
        elif args.test_client:
            TestLog(port=args.port, hostname=args.hostname).run()
        elif args.test_webclient:
            WebTestLog(port=args.port, hostname=args.hostname).run()
            
    if args.daemon:
        import daemon
        with daemon.DaemonContext():
            main()
    else:
        main()
        
