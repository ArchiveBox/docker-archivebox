# docker-archivebox

The official Docker image for [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox), the self-hosted internet archiving solution.

https://hub.docker.com/r/archivebox/archivebox
```bash
docker pull archivebox/archivebox:dev
```

**Platforms Supported:**
- `amd64` all x86 64-bit Intel/AMD processors
- `arm64` Raspberry Pi v4+, M1 Macs, and other newer ARM-based systems (>= ARM v8)
- `arm/v7` Raspberry Pi v1 - v3 and other older ARM-based systems (as of v0.6, but support will be phased out in the future)

**Platforms _NOT_ Supported:**
- `i386` all x86 **32-bit** Intel/AMD processors
- `arm/v6` or earlier pre-2006 32-bit ARM-based systems
- `riscv64`/`riscv32` or other RISC-V-based systems
- `ppc64le`/`ppc32` or other PowerPC-based systems
- `s390x` or other IBM zSystem-based systems

**Tags available:**

It's recommended to use either `:master` (stable, all architectures) or `:dev` (beta/unstable).

- `:latest` (the default stable tag, 1:1 with `:master`, only built for `amd64`)
- `:dev`/`:master`/`:<branchname>` (tags for each git branch, built for `amd64`, `arm64`, `arm/v7`)
- `sha-2c7be14`/`:sha-<commitid>` (tags for each git commit, built for `amd64`, `arm64`, `arm/v7`)

*For a full list of the published images: https://hub.docker.com/r/archivebox/archivebox/tags*

<img width="500px" alt="Docker Hub Screenshot" src="https://user-images.githubusercontent.com/511499/147287184-6f1201f8-6827-4002-a6a3-3aae7eb859d4.png">

## Docker

```bash
mkdir ~/archivebox && cd ~/archivebox  # data folder can be anywhere
docker pull archivebox/archivebox
docker run -v $PWD:/data -it archivebox/archivebox init --setup
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

**`docker-compose.yml`:**
```yaml
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
docker-compose pull
docker-compose up

# docker-compose run archivebox [subcommand] [...args]

docker-compose run archivebox version
docker-compose run archivebox setup --init
docker-compose run archivebox add --depth=1 'https://example.com'
...
```

To enable Sonic full-text search backend and other optional extras, see: https://github.com/ArchiveBox/ArchiveBox/blob/dev/docker-compose.yml#L30

---

## Kubernetes

(BETA: Advanced users only, ArchiveBox does not provide support for Kubernetes users)

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

#### Usage

```bash
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
./bin/release.sh
```

**Inspecting the image:**

```bash
docker image ls archivebox/archivebox

docker image inspect <image id>  # view image details
docker image history <image id>  # view image layer sizes
```
---


*Please note: The old image at [`nikisweeting/archivebox`](https://hub.docker.com/r/nikisweeting/archivebox) is deprecated, use [`archivebox/archivebox`](https://hub.docker.com/r/archivebox/archivebox) instead.*

