# docker-archivebox

The official Docker image for [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox), the self-hosted internet archiving solution.

https://hub.docker.com/r/archivebox/archivebox

```bash
docker pull archivebox/archivebox

# using Docker Compose
mkdir -p ~/archivebox/data && cd ~/archivebox
curl -fsSL 'https://github.com/ArchiveBox/ArchiveBox/raw/dev/docker-compose.yml' > docker-compose.yml
docker compose up

# using Docker:
mkdir -p ~/archivebox/data && cd ~/archivebox/data
docker run -v $PWD:/data -it archivebox/archivebox init --setup
```

- [`Dockerfile`](https://github.com/ArchiveBox/ArchiveBox/blob/main/Dockerfile)
- [`docker-compose.yml`](https://github.com/ArchiveBox/ArchiveBox/blob/main/docker-compose.yml)
- [`archivebox-kubernetes.yml`](https://github.com/ArchiveBox/docker-archivebox/blob/master/archivebox.yml)
- [ArchiveBox Docker Quickstart](https://github.com/ArchiveBox/ArchiveBox#quickstart) + [Usage](https://github.com/ArchiveBox/ArchiveBox/wiki/Docker) + [Configuration](https://github.com/ArchiveBox/ArchiveBox/wiki/Docker#configuration) + [Upgrading](https://github.com/ArchiveBox/ArchiveBox/wiki/Upgrading-or-Merging-Archives) documentation

#### ✅ Operating Systems Supported

**Linux, macOS, Windows**  
  
*Any OS where [Docker](https://docs.docker.com/engine/install/) or [Docker Desktop](https://docs.docker.com/get-docker/) is supported.*

#### ✅ CPU Architectures Supported

- `amd64` all x86 64-bit Intel/AMD processors
- `arm64` Raspberry Pi v4+, M1/M2/M3 or newer Macs, and other newer ARM-based systems (>= ARM v8)
- `arm/v7` Raspberry Pi v1 - v3 and other 32-bit ARM-based systems (as of v0.7, but support will be phased out in the future)

#### ❌ CPU Architectures _NOT_ Supported

- `i386` all x86 **32-bit** Intel/AMD processors
- `arm/v6`/`arm/v5` or earlier pre-2006 32-bit ARM-based systems
- `riscv64`/`riscv32` or other RISC-V-based systems
- `ppc64le`/`ppc32` or other PowerPC-based systems
- `s390x` or other IBM zSystem-based systems

#### Tags available

It's recommended to use either `:main` (stable, all architectures) or `:dev` (beta/unstable).

- `:latest` (the default stable tag, 1:1 with `:master`, only built for `amd64`)
- `:dev`/`:main`/`:<branchname>` (tags for each git branch, built for `amd64`, `arm64`, `arm/v7`)
- `sha-2c7be14`/`:sha-<commitid>` (tags for each git commit, built for `amd64`, `arm64`, `arm/v7`)

*For a full list of the published images: https://hub.docker.com/r/archivebox/archivebox/tags*

<img width="500px" alt="Docker Hub Screenshot" src="https://user-images.githubusercontent.com/511499/147287184-6f1201f8-6827-4002-a6a3-3aae7eb859d4.png">


## Docker

```bash
mkdir ~/archivebox && cd ~/archivebox  # data folder can be anywhere
docker pull archivebox/archivebox
docker run -v $PWD:/data -it archivebox/archivebox init --setup
docker run -v $PWD:/data -it -p 8000:8000 archivebox/archivebox server --quick-init 0.0.0.0:8000
```

#### Usage

```bash
# docker run -v $PWD:/data -it archivebox/archivebox [subcommand] [...args]

docker run -v $PWD:/data -it archivebox/archivebox version
docker run -v $PWD:/data -it archivebox/archivebox init --setup
docker run -v $PWD:/data -it archivebox/archivebox add 'https://example.com'
docker run -v $PWD:/data -it -p 8000:8000 archivebox/archivebox server 0.0.0.0:8000

open http://127.0.0.1:8000
```

---

## Docker Compose

```bash
curl -fsSL 'https://github.com/ArchiveBox/ArchiveBox/raw/dev/docker-compose.yml' > docker-compose.yml
```

**`docker-compose.yml`:**
```yaml

# SIMPLE EXAMPLE
# see more complete setup here:
# https://github.com/ArchiveBox/ArchiveBox/blob/dev/docker-compose.yml

version: '3.9'

services:
    archivebox:
        image: 'archivebox/archivebox:dev'
        command: server --quick-init 0.0.0.0:8000
        ports:
            - 8000:8000
        environment:
            # add any ArchiveBox config options you want here
            - ALLOWED_HOSTS=*
            - MEDIA_MAX_SIZE=750m
        volumes:
            - ./data:/data
```

#### Usage

```bash
mkdir ~/archivebox && cd ~/archivebox
# create docker-compose.yml file in ~/archivebox
docker compose pull
docker compose up

# docker compose run archivebox [subcommand] [...args]

docker compose run archivebox version
docker compose run archivebox setup --init
docker compose run archivebox add --depth=1 'https://example.com'
...
```

To enable Sonic full-text search backend and other optional extras, see: https://github.com/ArchiveBox/ArchiveBox/blob/dev/docker-compose.yml#:~:text=sonic

---

## Kubernetes

(BETA: Advanced users only, ArchiveBox does not test releases on Kubernetes, but it should work in theory)

[`./archivebox.yml`](https://github.com/ArchiveBox/docker-archivebox/blob/master/archivebox.yml) contains an example Kubernetes manifest (with `rook-ceph-rbd` and `metallb`).

Use as-is, or edit to your needs, objects will be created in namespace: `archivebox`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: archivebox-deployment
spec:
  selector:
    matchLabels:
      app: archivebox
  replicas: 1
  template:
    metadata:
      labels:
        app: archivebox
    spec:
      containers:
        - name: archivebox
          args: ["server", "--quick-init", "0.0.0.0:8000"]
          image: archivebox/archivebox
          ports:
            - containerPort: 8000
              protocol: TCP
              name: http
          volumeMounts:
            - mountPath: /data
              name: archivebox
      restartPolicy: Always
      volumes:
        - name: archivebox
          persistentVolumeClaim:
            claimName: archivebox
```

```bash
# run this to apply the configuration
kubectl apply -f archivebox.yml
```

---

## Development

The image is built using `docker`: https://docs.docker.com/get-docker/ and hosted on Docker Hub & Github Packages: https://hub.docker.com/r/archivebox.

https://hub.docker.com/r/archivebox/archivebox

The config file / package definition is here: [`ArchiveBox/Dockerfile`](https://github.com/ArchiveBox/ArchiveBox/blob/master/Dockerfile).

To build this package, make sure you are in the ArchiveBox main repo first.

```bash
cd ArchiveBox/
git pull --recurse-submodules

# Build the docker image
./bin/build_docker.sh

# Push the image to Docker Hub & Github Packages
docker login
./bin/release_docker.sh 0.7.1 arm7 
```

### Inspecting the image layers

```bash
docker image ls archivebox/archivebox

docker image inspect <image id>  # view image details
docker image history <image id>  # view image layer sizes
```
---


*Please note: The old image at [`nikisweeting/archivebox`](https://hub.docker.com/r/nikisweeting/archivebox) is deprecated, use [`archivebox/archivebox`](https://hub.docker.com/r/archivebox/archivebox) instead.*

