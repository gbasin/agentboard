#include <signal.h>
#include <pthread.h>
#include <stdint.h>
uint64_t disposition(int sig) {struct sigaction a;sigaction(sig,0,&a);return (uint64_t)a.sa_handler;}
int blocked(int sig) {sigset_t mask;pthread_sigmask(SIG_BLOCK,0,&mask);return sigismember(&mask,sig);}
int unblock(int sig) {sigset_t mask;sigemptyset(&mask);sigaddset(&mask,sig);return pthread_sigmask(SIG_UNBLOCK,&mask,0);}
