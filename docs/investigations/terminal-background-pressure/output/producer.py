import sys,threading,time
flood=False
counter=0
def writer():
 global counter
 while True:
  if flood:
   block=''.join(f'{counter+i:010d} '+('X'*100)+'\r\n' for i in range(128))
   counter+=128
   sys.stdout.write(block);sys.stdout.flush()
  time.sleep(.01)
threading.Thread(target=writer,daemon=True).start()
for line in sys.stdin:
 cmd=line.strip()
 if cmd=='FLOOD':flood=True
 elif cmd=='STOP':flood=False;sys.stdout.write('\r\nSTOPPED\r\n');sys.stdout.flush()
 else:sys.stdout.write(line);sys.stdout.flush()
