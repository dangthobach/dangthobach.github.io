---
Created by: Bách Đặng Thọ
Created time: 2025-09-15T05:34
---
Containers, led by technologies like Docker, offer a lightweight, portable, and consistent way to package applications and their dependencies.

However, managing containers at scale introduces significant challenges such as:

- Deploying hundreds or thousands of containers.

- Ensuring the containers communicate seamlessly, recover from failures, and scale as demand grows.

This is where Kubernetes comes in.

Kubernetes, often abbreviated as K8s, is an open-source container orchestration platform originally developed by Google and now maintained by the Cloud Native Computing Foundation (CNCF).

It helps automate the deployment, scaling, and management of containerized applications, enabling developers and DevOps teams to focus on building software rather than dealing with infrastructure complexities.

In this article, we’ll learn about the fundamentals of Kubernetes, including key concepts like Pods, Services, and Deployments.

We will also break down the Kubernetes architecture and its core components. Lastly, we will look at some best practices for managing resources and scaling Kubernetes.

[![](https://substackcdn.com/image/fetch/$s_!Oyvm!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4876c777-96bb-4563-bc98-60561dbc4442_1493x1600.png)](https://substackcdn.com/image/fetch/$s_!Oyvm!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4876c777-96bb-4563-bc98-60561dbc4442_1493x1600.png)

## **The Relevance of Kubernetes**

Let us first answer the fundamental question: What makes Kubernetes relevant?

Containers provide a consistent and efficient way to package and run applications. While managing containers manually can work well for smaller applications, doing so in real-world projects is quite different and the operational complexities quickly become unmanageable.

Some challenges of managing containers manually are as follows:

- **Container Sprawl:** As applications scale, the number of containers running in production can quickly grow to hundreds or even thousands. Even developers dedicated solely to container management will find it difficult to handle them.

- **Scaling Issues:** Modern applications often need to scale up or down dynamically based on user demand. Doing so manually with containers is time-consuming and prone to human errors.

- **Failure Recovery:** Containers are inherently ephemeral and may crash or become unresponsive for various reasons. Without a system to monitor and recover from failures, operators must manually identify and restart failed containers, often leading to downtime and service disruptions.

- **Networking and Communication:** Containers within a system need to communicate with each other and external clients reliably. Setting up and maintaining this networking manually, especially as containers move between hosts, is complex and error-prone.

In other words, as software systems increase in complexity, the manual management of containers quickly becomes unmanageable.

To address these challenges, container orchestration systems like Kubernetes become relevant. It provides multiple features such as:

- **Declarative Management:** We can define the desired state of the application, and Kubernetes ensures it is maintained.

- **Auto-Scaling:** Scale applications dynamically based on demand or resource usage.

- **Self-Healing:** Automatically restart failed containers and replace unhealthy ones.

- **Simplified Networking:** Kubernetes provides a built-in service mechanism to enable communication between containers, regardless of where they run.

- **Portability:** Run your applications consistently across on-premises, hybrid, and multi-cloud environments.

## **How do Developers see Kubernetes?**

For application developers working with Kubernetes, the process can be broken down into three simple steps:

- **Step 1:** Developers create manifest files (typically written in YAML or JSON) that describe their applications, specifying the number of instances, resource requirements, and configurations. These manifest files are then submitted to Kubernetes.

- **Step 2:** Kubernetes takes these manifest files, validates them, and deploys the applications across its cluster of worker nodes, ensuring that resources are allocated appropriately.

- **Step 3:** Kubernetes continuously manages the entire lifecycle of the applications based on the instructions provided in the manifest files. This includes tasks like scaling, restarting failed containers, and ensuring the desired state of the application is maintained.

See the diagram below that shows this perspective.

[![](https://substackcdn.com/image/fetch/$s_!YVal!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F653e0438-439e-408b-be3d-a758285ca2e1_1600x970.png)](https://substackcdn.com/image/fetch/$s_!YVal!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F653e0438-439e-408b-be3d-a758285ca2e1_1600x970.png)

From a developer’s perspective, the abstraction Kubernetes provides is incredibly powerful because it eliminates the need to manually manage deployment environments.

Developers only need to define the desired state of their applications in the manifest files, and Kubernetes takes care of the rest. For example, if a developer wants two instances of Application A, four instances of Application B, and specific resource limits, it can be simply described in the manifest files.

The use of Kubernetes allows developers to focus on building and improving their applications without worrying about infrastructure management.

## **Kubernetes Architecture**

Kubernetes operates using a control plane and a group of nodes. These components work together to manage the entire system.

The diagram below shows the high-level architecture of Kubernetes.

[![](https://substackcdn.com/image/fetch/$s_!qpFy!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F946d8fa4-b85d-4b3e-8608-3f560781e8c9_1600x990.png)](https://substackcdn.com/image/fetch/$s_!qpFy!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F946d8fa4-b85d-4b3e-8608-3f560781e8c9_1600x990.png)

Let’s break down the key components to get a better understanding of their purpose.

### **Kubernetes Control Plane**

The Control Plane is like the brain of Kubernetes.

It is deployed on the master node and manages the overall state of the cluster, making decisions about scheduling, scaling, and maintaining the desired state of the applications.

The control panel is made up of multiple components:

### **1 - API Server (kube-apiserver)**

The API Server receives all incoming requests (for example, deploying an app, scaling pods, or checking statuses) from users or other Kubernetes components. We will talk more about Kubernetes resources and components in later sections.

Think of the API Server as a traffic controller that accepts requests (instructions) and directs them to the right Kubernetes component. When we use a command like kubectl apply to deploy an application, the API Server processes the request and ensures the cluster takes action.

### **2 - Etcd**

Etcd is the key-value store where Kubernetes keeps all of its data, including configurations, cluster states, and desired states of applications.

Imagine etcd as a notebook where Kubernetes writes down everything it needs to remember about the cluster. For example, if we define that we want 3 replicas of an app in a manifest file, Kubernetes stores this desired state in etcd.

### **3 - Controller Manager (kube-controller-manager)**

The Controller Manager ensures that the cluster’s desired state matches the actual state.

It runs multiple “controllers” that handle specific tasks, such as creating pods, managing endpoints, and monitoring nodes. If a node crashes and some pods go offline, the Controller Manager identifies the issue and spins up new pods on healthy nodes to match the desired state.

### **4 - Scheduler (kube-scheduler)**

The Scheduler decides where to run new pods based on resource availability and constraints. It looks at the cluster’s nodes and finds the best spot for each pod.

For example, if we deploy 5 pods, the Scheduler finds nodes with enough CPU and memory to run them. Think of the Scheduler as the seating manager in a restaurant.

### **Kubernetes Node Components**

Nodes are the workers in a Kubernetes cluster. Each node is responsible for running the actual containerized applications.

The nodes also contain Kubernetes components such as:

### **1 - Kubelet**

The Kubelet is the main worker on each node. It gets instructions from the API Server and ensures that the instructions are applied as expected.

For example, if the API Server tells the Kubelet to run 2 containers for an app, the Kubelet makes sure those containers are created and kept alive.

### **2 - Kube-proxy**

Kube-proxy handles networking on each node. It ensures that services can communicate with pods and traffic is properly routed across the cluster.

If an external request for a web app is received, Kube-proxy routes it to one of the pods running that particular app.

### **The Flow of a Request in Kubernetes**

To understand how Kubernetes handles a developer's request, let’s trace the journey of a simple deployment command (like creating a pod) from the developer to a running container on a node.

Along the way, we’ll see how the key components (API Server, etcd, Scheduler, Controller Manager, and Kubelet) interact to ensure the desired state is achieved.

The diagram below shows the various steps.

[![](https://substackcdn.com/image/fetch/$s_!Swyf!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9c1c9ac2-a0c2-473f-bb7a-613611665dca_1600x921.png)](https://substackcdn.com/image/fetch/$s_!Swyf!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9c1c9ac2-a0c2-473f-bb7a-613611665dca_1600x921.png)

Here’s what happens in each step:

### **Step 1 - The Developer Submits a Request**

A developer creates a manifest file (YAML or JSON) describing the desired state, such as deploying a pod or scaling an application. Then, the developer runs a command, like:

```Plain
kubectl apply -f my-app.yaml
```

The kubectl command-line tool sends this request to the API Server.

### **Step 2 - API Server Processes the Request**

The API Server (kube-apiserver) receives the request and validates the manifest file for correctness (syntax, resource names, etc.).

After validation, the API Server stores the request in etcd, the cluster's key-value store. This is to ensure the current state of the cluster (what’s running) and the desired state (what the developer wants) are tracked persistently.

### **Step 3 - Scheduler Assigns a Node**

Once the request is stored in etcd, the Scheduler steps in. It checks the cluster’s available nodes and resources to determine the best place to run the pod.

The Scheduler also considers factors like CPU, memory availability, and affinity rules to make its decision. After assigning the pod to a specific node, the Scheduler updates the API Server with this information.

### **Step 4 - Kubelet Starts the Pod on the Node**

The API Server informs the Kubelet (the main worker agent) on the chosen node about the new pod to be created.

The Kubelet pulls the container image from a container registry such as Docker Hub and starts the container on the node using the container runtime (for example, Docker). It then monitors the pod to ensure it is running as expected.

### **Step 5 - The Pod Runs and Reports Back**

Once the container is up and running, the Kubelet communicates with the API Server, confirming that the pod has been successfully started.

The API Server updates etcd with the current state of the cluster to reflect this change. If something goes wrong (such as the container crashing), the Controller Manager detects this issue and restarts the pod to ensure the desired state is restored.

## **Core Kubernetes Resources**

Let us look at some core Kubernetes concepts that a developer must know when working with it on a project.

### **Pods**

A Pod is the smallest and simplest deployable unit in Kubernetes.

Pods encapsulate one or more containers, storage resources, and configuration options needed for the containerized application to run. Containers in a Pod run together on the same node and  Kubernetes uses Pods as the deployable unit rather than individual containers.

In simple terms, a Pod is a wrapper for containers. It provides an environment where containers can share storage, network, and lifecycle management.

[![](https://substackcdn.com/image/fetch/$s_!AoSV!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fb07ad532-a0d4-4bd8-9b58-cdefc77ff4dc_1600x1020.png)](https://substackcdn.com/image/fetch/$s_!AoSV!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fb07ad532-a0d4-4bd8-9b58-cdefc77ff4dc_1600x1020.png)

Some key features of Pods are as follows:

- A Pod can host a single container, which is the most common use case. Alternatively, a Pod can run multiple containers that are coupled in some way. For example, a primary app container and a sidecar container for logging.

- The containers in a Pod share the same IP address and port space. They can also share volumes for persistent storage.

- Pods are designed to be short-lived. If a Pod fails, Kubernetes will restart it (or replace it) to match the desired state.

Below is a simple YAML example that defines a Pod running a single container with an NGINX web server. Note that all the code samples are just for demo purposes and to explain the concept.

```Plain
apiVersion: v1
kind: Pod
metadata:
  name: nginx-pod
  labels:
    app: webserver
spec:
  containers:
    - name: nginx-container
      image: nginx:latest
      ports:
        - containerPort: 80
```

Here’s what the various parts of the YAML file mean:

- **apiVersion**: Defines the Kubernetes API version to use. v1 is the stable API version for Pods.

- **kind**: Specifies the type of Kubernetes object. Here, it is a Pod.

- **metadata**:
    
    - name: A unique name for the Pod within the namespace.
    
    - labels: Key-value pairs used to organize and identify the Pod.
    

- **Spec**: Describes the desired behavior of the Pod.
    
    - containers: A list of containers in the Pod.
        
        - name: A name for the container inside the Pod.
        
        - image: The container image to pull from a container registry such as Docker Hub
        
        - ports: The port(s) exposed by the container.
        
    

To create this Pod, we can save the above YAML in a file named nginx-pod.yaml and run the following command:

```Plain
kubectl apply -f nginx-pod.yaml
```

### **Deployments**

A Deployment in Kubernetes is a higher-level abstraction that manages Pods and ensures they run consistently and reliably.

While Pods are the smallest units in Kubernetes, they are ephemeral and can be replaced or terminated. A Deployment allows you to define and maintain the desired state of your application, making it easier to:

- Scale the number of Pods (replicas) up or down based on load or requirements.

- Perform rolling updates to deploy new versions of your application without downtime.

- Roll back to a previous stable version if something goes wrong.

- Monitor and ensure that the desired number of Pods are always running.

[![](https://substackcdn.com/image/fetch/$s_!B11A!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F14f4ff0b-a3e5-4638-b3ee-1cd8439f2fc8_1600x1020.png)](https://substackcdn.com/image/fetch/$s_!B11A!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F14f4ff0b-a3e5-4638-b3ee-1cd8439f2fc8_1600x1020.png)

When we create a Deployment, it creates and manages a ReplicaSet, which is responsible for maintaining the desired number of Pod replicas. If a Pod fails or a node crashes, the ReplicaSet ensures that a new Pod is created to match the desired state defined in the Deployment.

The following YAML demonstrates creating a Deployment that runs the NGINX web server.

```Plain
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
  labels:
    app: nginx
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
        - name: nginx-container
          image: nginx:latest
          ports:
            - containerPort: 80
```

Here’s what the various components of the YAML file mean:

- **apiVersion**: Specifies the Kubernetes API version for Deployments. (apps/v1 is the stable version.)

- **kind**: Defines the object type as a Deployment.

- **metadata**:
    
    - name: A unique name for the Deployment.
    
    - labels: Used to categorize and identify the Deployment.
    

- **spec**: Describes the desired behavior of the Deployment.
    
    - replicas: Specifies the desired number of Pod replicas.
    
    - selector: Determines which Pods the Deployment manages using labels.
    
    - template: Defines the Pod specification.
    

To create the deployment, we can save the YAML file as deployment.yaml and apply it using the kubectl command:

```Plain
kubectl apply -f deployment.yaml
```

Kubernetes will create the Deployment, which in turn provisions 3 replicas of the NGINX Pod on an appropriate node.

To scale the Deployment from 3 to 5 replicas, we can use the following command:

```Plain
kubectl scale deployment nginx-deployment --replicas=5
```

### **Services**

In Kubernetes, a Service is an abstraction that provides a stable way to expose and access a set of Pods.

Since Pods are ephemeral (they can be terminated or restarted), their IP addresses keep changing. Services solve this problem by providing a static endpoint (IP and DNS name) to connect to a group of Pods.

[![](https://substackcdn.com/image/fetch/$s_!PmQf!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc0706124-c9ce-4e44-91c6-fe6c51c8ad4d_1600x1087.png)](https://substackcdn.com/image/fetch/$s_!PmQf!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc0706124-c9ce-4e44-91c6-fe6c51c8ad4d_1600x1087.png)

A Service uses labels and selectors to determine which Pods they should route traffic to.

Kubernetes supports several types of Services. The most commonly used are:

- **ClusterIP:** Exposes the service internally within the cluster and creates a virtual IP address only accessible from within the cluster. This is suitable for internal communication between Pods.

- **NodePort:** Exposes the service on a static port (range: 30000–32767) on every node in the cluster. This allows external traffic to access the service using the NodeIP and NodePort. It is useful for testing or exposing applications externally without a cloud load balancer.

- **LoadBalancer:** Exposes the service externally using a cloud provider's load balancer (for example, AWS ELB, Azure Load Balancer, or GCP Load Balancer). The service automatically provisions an external IP address and is ideal for production workloads that require external access to the application.

See the YAML example below for a simple NodePort Service.

```Plain
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: nginx
        image: nginx:latest
        ports:
        - containerPort: 8080
```

### **ConfigMaps and Secrets**

Kubernetes provides ConfigMaps and Secrets to manage application configurations and sensitive data. Both allow you to decouple configuration data from the application code, making your applications more portable, flexible, and easier to manage.

- A ConfigMap is a Kubernetes object that allows you to store non-sensitive configuration data as key-value pairs. It is typically used for application settings, environment variables, or configuration files that do not contain sensitive information.

- A Secret is similar to a ConfigMap but is designed to store sensitive data such as passwords, tokens, SSH keys, and API credentials. The data in Secrets is base64-encoded to add a basic level of obfuscation.

Below is an example YAML file to create a ConfigMap:

```Plain
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  APP_NAME: "MyK8sApp"
  APP_ENV: "production"
```

Next, we can also create a secret as follows:

```Plain
apiVersion: v1
kind: Secret
metadata:
  name: app-secret
type: Opaque
data:
  DB_PASSWORD: bXlzdXBlcnNlY3JldA==    # Base64-encoded value
```

Now, we can create a Pod that uses the ConfigMap and Secret.

```Plain
apiVersion: v1
kind: Pod
metadata:
  name: app-pod
spec:
  containers:
    - name: app-container
      image: nginx:latest
      env:
        - name: APP_NAME
          valueFrom:
            configMapKeyRef:
              name: app-config       # Name of the ConfigMap
              key: APP_NAME          # Key in the ConfigMap
        - name: APP_ENV
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: APP_ENV
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: app-secret       # Name of the Secret
              key: DB_PASSWORD       # Key in the Secret
```

In the Pod YAML, we define the env section and use configMapKeyRef to pull values (APP_NAME and APP_ENV) from the ConfigMap. Also, the env section uses secretKeyRef to inject the DB_PASSWORD from the Secret.

### **Persistent Volumes and Persistent Volume Claims**

In Kubernetes, applications can be classified into two categories: Stateless and Stateful.

The main difference lies in whether the application needs to retain data or state across Pod restarts.

- Stateless applications do not retain data or "state" between sessions. Each request is processed independently, and no prior information is stored. For example, web servers, and application services.

- Stateful applications retain data or "state" between restarts or recreations. They need persistent storage to maintain their data, such as databases or file systems. For example, databases, message queues, and storage systems.

To manage stateful applications in Kubernetes, we need Persistent Volumes (PVs) and Persistent Volume Claims (PVCs):

- A Persistent Volume is a storage resource in the cluster that is provisioned either statically or dynamically. It represents actual storage like NFS, disks, or local storage.

- A Persistent Volume Claim is a request for storage by a user or application. It binds to an available Persistent Volume.

See the diagram below that shows the relation between the actual storage, Persistent Volume, and Persistent Volume Claims.

[![](https://substackcdn.com/image/fetch/$s_!K_d3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fcbba5fa1-4d2b-4b20-8b29-0a6b5f4846f3_1600x1087.png)](https://substackcdn.com/image/fetch/$s_!K_d3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fcbba5fa1-4d2b-4b20-8b29-0a6b5f4846f3_1600x1087.png)

The YAML file below defines a PV:

```Plain
apiVersion: v1
kind: PersistentVolume
metadata:
  name: mysql-pv
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  hostPath:
    path: "/mnt/data"
```

Here, we specify the capacity, access modes, and the host path (storage on the worker node’s local filesystem).

Below is the YAML file for a PVC for a database:

```Plain
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mysql-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

It specifies the amount of storage requests and access mode. When this PVC is applied, Kubernetes will bind it to the mysql-pv Persistent Volume.

Lastly, here’s the YAML for a Pod configuration that uses the PVC for persistent storage:

```Plain
apiVersion: v1
kind: Pod
metadata:
  name: mysql-pod
  labels:
    app: mysql
spec:
  containers:
    - name: mysql-container
      image: mysql:5.7
      ports:
        - containerPort: 3306
      env:
        - name: MYSQL_ROOT_PASSWORD
          value: "mypassword"
      volumeMounts:
        - name: mysql-storage
          mountPath: /var/lib/mysql
  volumes:
    - name: mysql-storage
      persistentVolumeClaim:
        claimName: mysql-pvc
```

This configuration mounts the PV at /var/lib/mysql, which is the default directory for MySQL data. It uses the mysql-pvc to attach the storage to the pod.

## **Scaling Applications with Kubernetes**

Kubernetes provides powerful scaling mechanisms to ensure applications can handle varying workloads efficiently.

Scaling in Kubernetes can happen at two levels:

- **Pod-Level Scaling:** Increasing or decreasing the number of Pods running in a Deployment. It is achieved using the Horizontal Pod Autoscaler (HPA).

- **Cluster-Level Scaling:** Dynamically adding or removing nodes in a Kubernetes cluster to accommodate changing resource demands. It is managed by the Cluster Autoscaler.

Let’s look at both in detail:

### **Horizontal Pod Autoscaler (HPA)**

The Horizontal Pod Autoscaler automatically scales the number of Pods in a Deployment, ReplicaSet, or StatefulSet based on observed CPU utilization, memory usage, or custom metrics.

HPA continuously monitors resource usage and adjusts the number of replicas to match the desired resource targets.

See the diagram below that shows how the HPA works:

[![](https://substackcdn.com/image/fetch/$s_!P0cC!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F26b67198-d31b-490c-b32a-cdbd629734e6_1600x1105.png)](https://substackcdn.com/image/fetch/$s_!P0cC!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F26b67198-d31b-490c-b32a-cdbd629734e6_1600x1105.png)

The YAML file below defines an HPA that scales a deployment based on CPU usage levels.

```Plain
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: nginx-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nginx-deployment
  minReplicas: 2
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50
```

### **Cluster Autoscaler**

The Cluster Autoscaler automatically adjusts the number of nodes in a Kubernetes cluster.

If the Pods cannot be scheduled due to insufficient resources, the Cluster Autoscaler adds nodes. When nodes are underutilized (for example, no Pods running), it removes nodes to optimize resource costs.

Here’s how it works:

- Cluster Autoscaler monitors the scheduling status of Pods.

- If Pods are Pending because of insufficient CPU or memory, the Autoscaler provisions new nodes.

- Conversely, if nodes remain underutilized for a while, the Autoscaler removes those nodes.

Cluster Autoscaler is typically configured at the cloud provider level as part of the cluster setup. See the diagram below that shows how a cluster auto-scaler works.

[![](https://substackcdn.com/image/fetch/$s_!ELCE!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F83449ea6-38fa-449e-b42a-c8fcf7d71a21_1600x1105.png)](https://substackcdn.com/image/fetch/$s_!ELCE!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F83449ea6-38fa-449e-b42a-c8fcf7d71a21_1600x1105.png)

## **Best Practices for Kubernetes Adoption**

To ensure smooth adoption and efficient use of Kubernetes in production, it’s important to follow some best practices:

### **Organizing Kubernetes Manifests**

Effective organization of Kubernetes manifests makes deployments cleaner, scalable, and easy to maintain. Some tips are as follows:

- Use consistent naming conventions. For example,
    
    - Lowercase names with hyphens for the resource names such as nginx-deployment, myapp-service.
    
    - Also, prefix resources with application names such as myapp-secret.
    

- Organize manifests logically in directories.

- Use separate directories for development, staging, and production.

- Store manifests in a Git repository for version control.

### **Namespaces and RBAC**

Namespaces help isolate resources within a Kubernetes cluster.

They are particularly useful for multi-tenant environments or separating environments like dev, test, and production.

RBAC controls who can access resources and what actions they can perform.

### **Monitoring and Logging**

Tools like Prometheus (metrics collection) and Grafana (visualization) are commonly used in Kubernetes for real-time monitoring:

- **Prometheus:** Scrapes metrics from Kubernetes components and Pods.

- **Grafana:** Displays metrics in customizable dashboards.

Centralized logging aggregates logs from all nodes and Pods for easy troubleshooting. Popular tools include the ELK Stack (Elasticsearch, Logstash, and Kibana).

### **Managing Secrets Securely**

Storing secrets (passwords, API keys) as plaintext in manifests is insecure and may expose sensitive information. Some basic security steps are as follows:

- Don’t store secrets as plaintext within the YAML files.

- Use sealed secrets to encrypt Kubernetes secrets so that only the cluster can decrypt them.

- Use a secure external solution like Hashicorp Vault to manage secrets and inject them into Pods dynamically.

## **Summary**

In this article, we’ve taken a detailed look at Kubernetes and its architecture. We’ve also understood the core concepts of Kubernetes with examples.

Let’s summarize our learnings in brief:

- Kubernetes solves challenges like container sprawl, scaling, and failure recovery through automated orchestration.

- Kubernetes operates using a Control Plane and a group of Nodes.

- The Control Plane manages the cluster state and includes components such as the API Server, ETCD, Controller Manager, and Scheduler.

- The Nodes contain the Kubelet and Kube-proxy.

- A typical request made by a developer to Kubernetes flows through these components.

- Some core Kubernetes concepts are Pods, Deployments, Services, ConfigMaps, Secrets, and Persistent Volumes.

- A Pod is the smallest and simplest unit in Kubernetes that represents a single instance of a running process.

- A Deployment in Kubernetes is a higher-level abstraction that manages Pods and ensures they run consistently and reliably.

- In Kubernetes, a Service is an abstraction that provides a stable way to expose and access a set of Pods.

- Kubernetes provides ConfigMaps and Secrets to manage application configurations and sensitive data.

- To manage stateful applications in Kubernetes, we need Persistent Volumes (PVs) and Persistent Volume Claims (PVCs)

- Kubernetes provides powerful scaling mechanisms to ensure applications can handle varying workloads efficiently. These include the Horizontal Pod Autoscaler (HPA) and the Cluster Autoscaler.